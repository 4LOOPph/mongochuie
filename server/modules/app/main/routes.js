'use strict';
var path = require('path');
var multiparty = require('multiparty');
var fs = require('fs');

module.exports = function (baboon, router) {
    var auth = baboon.middleware.auth;

    router.post('/import', function (req, res) {
        baboon.middleware.session.checkActivitySession(req, res, function () {
            var main = require(path.join(baboon.config.path.modules, 'app', 'main')).main(baboon);
            var socketio = baboon.socketIo;
            var form = new multiparty.Form();


            form.parse(req, function (err, fields, files) {
                var parsedFields = main.convertDataFromRequestForApp(fields);
                var usersSocketId = parsedFields.socketid;

                parsedFields.socket = (socketio && socketio.sockets && socketio.sockets.sockets) ? socketio.sockets.sockets[usersSocketId] : undefined;

                if (err) {
                    res.end(JSON.stringify({error: err}));
                } else {
                    //Send a SPACE every 10 Second to keep connection alive
                    var intervalId = setInterval(function () {
                        res.write(' ');
                    }, 10000);

                    var funcCall = fields.uploadOptionToInsert[0] === 'replace' ? 'importCollectionReplace' : 'importCollectionAppend';

                    main[funcCall](parsedFields, {content: files.content[0]} || {}, function (error, result) {
                        clearInterval(intervalId); // clear Interval
                        res.end(JSON.stringify({error: error, result: result}));
                    });
                }
            });
        });
    });

    router.get('/export/:filename', function (req, res) {
        baboon.middleware.session.checkActivitySession(req, res, function () {
            var pathToFile = path.join(baboon.config.path.appDataRoot, 'cache', req.params.filename);
            var contentType = req.params.filename.split('.');
            contentType = contentType.pop();

            res.setHeader('Content-disposition', 'attachment');
            res.setHeader('Content-Type', 'application/' + contentType);

            var fileStream = fs.createReadStream(pathToFile);

            fileStream.pipe(res);

            fileStream.on('error', function(error) {
                res.status(404).send(error);
            });

            fileStream.on('close', function() {
                fs.unlink(pathToFile);
            });
        });
    });

    router.get('/download/:info', function (req, res) {
        baboon.middleware.session.checkActivitySession(req, res, function () {
            var main = require(path.join(baboon.config.path.modules, 'app', 'main')).main(baboon);
            var infobuf = new Buffer(req.params.info, 'base64');
            var config = JSON.parse(infobuf.toString()) || {};

            main.downloadFile(config, function (error, filedata, fileinfo) {
                if (error) {
                    res.status(404).send(error);
                } else {
                    res.setHeader('Content-Disposition', 'attachment; filename=' + fileinfo.filename);
                    res.setHeader('Content-Type', fileinfo.contentType || 'application/octet-stream');
                    res.end(filedata || '', 'binary');
                }
            });
        });
    });

    router.get('*', auth.restrictedUser, function (req, res) {
        res.render('app/main/index');
    });

    return router;
};
