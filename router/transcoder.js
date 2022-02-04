
const pool = require('../db');
const hls = require('simple-hls');
const fs = require('fs');
const _path = require('path');
const Ffmpeg = require('fluent-ffmpeg');

module.exports = async function (app) {

    app.post('/transcoder/screenshot', async function (req, res) {
        let src = req.body.src;
        let dsc = req.body.dsc;
        const name = req.body.name;

        if (src == '' || dsc == '' || name == '') {
            res.status(500).send({ state: 'fail', message: 'empty entity' });
            return;
        }

        src = _path.join(src, name);
        const filename = _path.basename(name, _path.extname(name));

        Ffmpeg(src)
            .on('filenames', function () { })
            .on('end', function () {
                console.log(`screen complete!`);
            })
            .on('error', function () { console.log(`error!`) })
            .screenshot({
                count: 3,
                folder: dsc
            });

        res.status(200).send({
            result: 'success'
        });
    });

    app.post('/transcoder/to-hls', async function (req, res) {

        let src = req.body.src;
        let dsc = req.body.dsc;
        const name = req.body.name;

        if (src == '' || dsc == '' || name == '') {
            res.status(500).send({ state: 'fail', message: 'empty entity' });
            return;
        }

        src = _path.join(src, name);
        dsc = _path.join(dsc, _path.basename(name, _path.extname(name)));

        if (!fs.existsSync(src)) {
            res.status(200).send({
                result: 'fail',
                message: 'file not found'
            });
            return;
        }

        const idx = await transcoder_ready(name, src, dsc, '1');
        if (idx <= 0) {
            res.status(200).send({
                result: 'fail',
                message: 'db connect error'
            });
            return;
        }

        console.log(`start transcoding ${src} => ${dsc}`);

        transcoder_hls2(idx, src, dsc);

        res.status(200).send({
            result: 'success'
        });
    });

    app.post('/transcoder/to-test', async function (req, res) {

        let src = req.body.src;
        let dsc = req.body.dsc;
        const name = req.body.name;

        if (src == '' || dsc == '' || name == '') {
            res.status(500).send({ state: 'fail', message: 'empty entity' });
            return;
        }

        src = src + name;
        dsc = _path.join(dsc, _path.basename(name, _path.extname(name)));

        if (!fs.existsSync(src)) {
            res.status(200).send({
                result: 'fail',
                message: 'file not found'
            });
            return;
        }

        const idx = await transcoder_ready(name, src, dsc, '1');
        if (idx <= 0) {
            res.status(200).send({
                result: 'fail',
                message: 'db connect error'
            });
            return;
        }

        console.log(`start transcoding ${src} => ${dsc}`);

        talk_screenshot(idx, src, dsc);

        res.status(200).send({
            result: 'success'
        });
    });

    app.post('/transcoder/info', async function (req, res) {
        let src = req.body.src;
        const name = req.body.name;

        src = _path.join(src, name);

        const infs = new Ffmpeg(src);
        infs.ffprobe(function (err, metadata) {
            res.status(200).send(metadata);
        });
    });

    app.post('/transcoder/to-h264', async function (req, res) {

        let src = req.body.src;
        let dsc = req.body.dsc;
        const name = req.body.name;

        if (src == '' || dsc == '' || name == '') {
            res.status(500).send({ state: 'fail', message: 'empty entity' });
            return;
        }

        src = _path.join(src, name);
        dsc = _path.join(dsc, name);

        const idx = await transcoder_ready(name, src, dsc, '2');
        if (idx == undefined || idx <= 0) {
            res.status(500).send({ state: 'fail', message: 'create transcoder fail' });
            return;
        }

        console.log(`convert h264 ${idx} ${src} -> ${dsc} `);

        let start_function = async function () {
            await transcoder_start(idx);
            console.log(`convert h264 start`)
        }

        let command = Ffmpeg(src)
            .videoCodec('libx264')
            .audioBitrate('128k')
            .audioCodec('aac')
            .on('start', start_function)
            .on('error', async function (err) {
                await transcoder_err(idx, err.message);
                console.log(`convert h264 error ${err.message}`)
            })
            .on('end', async function () {
                await transcoder_complete(idx);
                console.log(`convert h264 done`);
            })
            .save(dsc);

        res.status(200).send({
            result: 'success'
        });
    });
};

async function transcoder_hls2(idx, src, _dsc) {

    await transcoder_start(idx);

    const dsc = _path.join(_dsc, 'vod');

    const screenshot_dsc = _path.join(_dsc, 'screenshot');
    fs.mkdirSync(screenshot_dsc, { recursive: true });

    Ffmpeg(src)
        .on('filenames', function () { })
        .on('end', function () {
            console.log(`screen complete!`);
            transcoder_screenshot(idx);
        })
        .on('error', function () { console.log(`error!`) })
        .screenshot({
            timestamps: ['5%', '50%', '95%'],
            folder: screenshot_dsc,
            filename: 'screenshot_%i.png'
        });

    const config = [
        {
            type: 'high',
            size: '1920x1080',
            ts_name: 'high%04d.ts',
            size_width: 1920,
            size_height: 1080,
            m3u8_str: `
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=7680000
high/index.m3u8`
        },
        {
            type: 'mid',
            size: '1280x720',
            ts_name: 'mid%04d.ts',
            size_width: 1280,
            size_height: 720,
            m3u8_str: `
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=2560000
mid/index.m3u8`
        }
    ];

    const base = {
        type: 'low',
        size: '640x360',
        ts_name: 'low%04d.ts',
        size_width: 640,
        size_height: 360,
        m3u8_str: `
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=1280000
low/index.m3u8`
    };

    fs.mkdirSync(dsc, { recursive: true });

    console.log(`convert hls ${idx} ${src} -> ${dsc} `);

    const infs = new Ffmpeg(src);
    infs.ffprobe(async function (err, metadata) {

        const width = metadata.streams[0].width;
        const height = metadata.streams[0].height;
        const durning = metadata.format.duration;

        await transcoder_duration(idx, durning);

        console.log(`metadata : ${width} x ${height}`);

        let m3u8_str = `
#EXTM3U
`;

        const infs2 = new Ffmpeg(src);
        for (let i = 0; i < config.length; i++) {
            const c = config[i];
            if (c.size_width > width && c.size_height > height) {
                continue;
            }

            const p = _path.join(dsc, c.type);
            fs.mkdirSync(p, { recursive: true });
            infs2.output(_path.join(p, 'index.m3u8')).size(c.size).autopad()
                .addOption('-hls_segment_filename', _path.join(p, c.ts_name))
                .addOption('-hls_time', 10)
                .addOption('-hls_list_size', 0);

            m3u8_str += c.m3u8_str;
        }

        const p = _path.join(dsc, base.type);
        fs.mkdirSync(p, { recursive: true });
        infs2.output(_path.join(p, 'index.m3u8')).size(base.size).autopad()
            .addOption('-hls_segment_filename', _path.join(p, base.ts_name))
            .addOption('-hls_time', 10)
            .addOption('-hls_list_size', 0);

        m3u8_str += base.m3u8_str;

        infs2.on('end', async function () {
            fs.writeFileSync(_path.join(dsc, 'index.m3u8'), m3u8_str);
            await transcoder_complete(idx);
            console.log('transcoder end');
        });
        infs2.on('error', async function (err) {
            await transcoder_err(idx, err.message);
            console.log(`convert h264 error ${err.message}`)
        });
        infs2.run();
    });
}

async function transcoder_hls(idx, src, _dsc) {

    const dsc = _path.join(_dsc, 'vod');

    fs.mkdirSync(dsc, { recursive: true });

    console.log(`convert hls ${idx} ${src} -> ${dsc} `);

    const r = new hls.Transcoder(src, dsc, { showLogs: true });
    try {

        await r.transcode();
        await transcoder_complete(idx);
    }
    catch (e) {
        console.log(`err : ${e}`);
        await transcoder_err(idx, e);
    }
}

async function talk_screenshot(idx, src, _dsc) {

    const dsc = _path.join(_dsc, 'screenshot');
    fs.mkdirSync(dsc, { recursive: true });

    Ffmpeg(src)
        .on('filenames', function () { })
        .on('end', function () {
            console.log(`screen complete!`);
            transcoder_screenshot(idx);
            transcoder_hls(idx, src, _dsc);
        })
        .on('error', function () { console.log(`error!`) })
        .screenshot({
            //count: 3,
            timestamps: ['10%', '50%', '90%'],
            folder: dsc,
            filename: 'screenshot_%i.png'
        });
}

async function transcoder_ready(name, src, dsc, type) {
    let connection = await pool.getConnection(async conn => conn);
    try {
        const q = ` INSERT INTO tbl_transcoder(name, src, dsc, state, type, reg_date) VALUES('${name}', '${src}', '${dsc}', '0', '${type}', NOW()) `;

        let result = await connection.query(q);
        return result[0].insertId;
    }
    catch (error) {
        console.log(`transcoder_ready db error ${error}`);
    }
    finally {
        connection.release();
    }

    return -1;
}

async function transcoder_duration(idx, dur)
{
    if (idx > 0) {
        let connection = await pool.getConnection(async conn => conn);
        try {
            const q = ` UPDATE tbl_transcoder SET duration = '${dur}', update_date = NOW() WHERE idx = ${idx} `;

            await connection.query(q);
        }
        catch (error) {
            console.log(`transcoder_start db error ${error}`);
        }
        finally {
            connection.release();
        }
    }
}

async function transcoder_screenshot(idx) {

    if (idx > 0) {
        let connection = await pool.getConnection(async conn => conn);
        try {
            const q = ` UPDATE tbl_transcoder SET state = '4', update_date = NOW() WHERE idx = ${idx} `;

            await connection.query(q);
        }
        catch (error) {
            console.log(`transcoder_start db error ${error}`);
        }
        finally {
            connection.release();
        }
    }
}

async function transcoder_start(idx) {

    if (idx > 0) {
        let connection = await pool.getConnection(async conn => conn);
        try {
            const q = ` UPDATE tbl_transcoder SET state = '1', update_date = NOW() WHERE idx = ${idx} `;

            await connection.query(q);
        }
        catch (error) {
            console.log(`transcoder_start db error ${error}`);
        }
        finally {
            connection.release();
        }
    }
}

async function transcoder_err(idx, msg) {

    if (idx > 0) {
        let connection = await pool.getConnection(async conn => conn);
        try {
            const q = ` UPDATE tbl_transcoder SET state = '2', update_date = NOW() WHERE idx = ${idx} `;
            await connection.query(q);

            const q2 = ` INSERT INTO tbl_transcoder_err(tr_idx, message, reg_date) VALUES(${idx}, '${msg}', NOW()) `;
            await connection.query(q2);
        }
        catch (error) {
            console.log(`transcoder_err db error ${error}`);
        }
        finally {
            connection.release();
        }
    }
}

async function transcoder_complete(idx) {

    if (idx > 0) {
        let connection = await pool.getConnection(async conn => conn);
        try {
            const q = ` UPDATE tbl_transcoder SET state = '3', update_date = NOW() WHERE idx = ${idx} `;

            await connection.query(q);
        }
        catch (error) {
            console.log(`transcoder_complete db error ${error}`);
        }
        finally {
            connection.release();
        }
    }
}