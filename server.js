#!/usr/bin/env node
'use strict';

var os = require('os');
var fs = require('fs');
var path = require('path');
var express = require('express');
var rootPath = __dirname;
var baboon = require('baboon')(rootPath);
var routes = require('./server/routes')(baboon);
var chalk = require('chalk');
var grunt = require('grunt');

// Express
var app = express();

// Express configuration
require('baboon/lib/config/express')(app, routes, baboon);

var server;

/**
 * Gets called after the server is successfully started
 */
function serverStartedCallback () {
    var config = baboon.config;
    var startOn = 'server has been started on: ' + config.protocol + '://' + config.host + ':' + config.port;
    var startMode = 'server has been started in ' + config.node_env + ' mode';

    baboon.loggers.syslog.info(startOn);
    baboon.loggers.syslog.debug(startMode);

    if (config.logging.loggers.syslog.appender !== 'console') {
        console.log(chalk.cyan('   info  - ') + startOn);
    }

    // write port to file so that node webkit can use it
    grunt.file.write(require('path').join(os.tmpdir(), 'mms_startup_config.json'), JSON.stringify({port: config.port}));

    // Socket.Io server
    baboon.socketIo = require('socket.io').listen(server);

    // Socket.Io configuration
    require('baboon/lib/config/socket-io')(baboon.socketIo, baboon);

    // MongoShell Helper
    require('./server/modules/app/main/mongoshell').create(baboon.socketIo);
}

/**
 * Start the web server
 */
function startServer () {
    server = baboon.appListen(app, serverStartedCallback);

    server.on('error', function (e) {
        if (e.code === 'EADDRINUSE') {
            baboon.loggers.syslog.warn('Port ' + baboon.config.port + ' is already in use');
            baboon.config.port++;

            // try to start server again with other port
            startServer();
        } else {
            throw e;
        }
    });
}

/**
 * Sync from
 *
 * @param sourceDir
 * @param targetDir
 */
function syncDir (sourceDir, targetDir) {
    (fs.readdirSync(sourceDir) || []).forEach(function (fileitem) {
        var sourceSubDir = path.join(sourceDir, fileitem);
        var targetSubDir = path.join(targetDir, fileitem);

        if (!fs.existsSync(sourceSubDir)) {
            return;
        }

        if (fs.statSync(sourceSubDir).isDirectory()) {
            if (!fs.existsSync(targetSubDir) || !fs.statSync(targetSubDir).isDirectory()) {
                fs.mkdirSync(targetSubDir);
            }

            syncDir(sourceSubDir, targetSubDir);
        } else {
            // Copy if file doesent exists
            if (!fs.existsSync(targetSubDir) || (fs.existsSync(targetSubDir) && !fs.statSync(targetSubDir).isFile())) {
                grunt.file.copy(sourceSubDir, targetSubDir);
            }
        }
    });
}

// Sync directory
if (baboon.config.useHomeDir === true && baboon.config.path.appDataRoot && baboon.config.path.appDataRoot !== baboon.config.path.root) {
    try {
        syncDir(path.join(baboon.config.path.root, 'server', 'var'), baboon.config.path.appDataRoot);
    } catch (e) {
        console.error('syncDir Error:\n', e);
    }
}

// start the server
startServer();

// Expose app
module.exports = app;
