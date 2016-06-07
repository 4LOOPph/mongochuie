/**
 * Created by Thomas Scheibe on 14.10.2014.
 */
'use strict';
var os = require('os'),
    path = require('path'),
    fs = require('fs'),
    processspawn = require('child_process').spawn,
    versionre = /([0-9].[0-9])/ig,
    platform = os.platform();

var mongobinarys = {
    'win32': 'mongo.exe',
    'darwin': './mongo',
    'linux': './mongo'
};

var MongoShellInstance = function (socket, config) {
    var mongoshell;
    var mongobinary = mongobinarys[platform] || 'mongo';
    var mongopath = path.normalize(path.join(__dirname, '/../../bin', process.arch));
    var mongodirs;
    var socketio = socket;
    var pub = {};

    var mongoversion = config.mongoversion || '2.4';
    var versionArray = mongoversion.split('.');
    mongoversion = versionArray[0] + '.' + versionArray[1];
    mongoversion = mongoversion.match(versionre)[0] || '2.4';

    // Get all available mongo shell version
    try {
        mongodirs = fs.readdirSync(mongopath);

        for (var useversion = 0; useversion < mongodirs.length; useversion++) {
            if (mongodirs[useversion] >= mongoversion)  {
                break;
            }
        }

        mongoversion = mongodirs[useversion];
    } catch(e) {
        // Failback for none existing mongoversion
        console.error('Mongoshell Exception while scanning for version number!', e);

        if (!fs.existsSync(path.join(mongopath, mongoversion))) {
            mongoversion = '2.4';
        }
    }

    // Remove username and password from connectionstring
    if (config.connectionstring) {
        var idxSlash = config.connectionstring.indexOf('/'),
            idxAt = config.connectionstring.lastIndexOf('@');

        if ((idxSlash !== -1 && idxAt < idxSlash) || (idxAt > 0)) {
            config.connectionstring = config.connectionstring.substr(idxAt + 1);
        }
    }

    try {
        if (!mongoversion) {
            throw new Error('Mongo shell not found! Requested version: ' + config.mongoversion);
        }

        //if (process.platform === 'win32' && process.arch !== 'x64' && mongoversion.charAt(0) !== '2') {
        //    throw new Error('We are sorry! Your os architecture is not supported by the Mongoshell.');
        //}

        mongoshell = processspawn(mongobinary, [config.connectionstring + '/' + (config.database || '')] || [], {cwd: path.join(mongopath, mongoversion)});

        // Set STDOUT and STDIN Encoding
        mongoshell.stdin.setEncoding('utf-8');
        mongoshell.stdout.setEncoding('utf-8');
        mongoshell.stderr.setEncoding('utf-8');

        // Process Events
        mongoshell.stdout.on('data', function (data) {
            if (socketio) {
                socketio.emit('mongoshell.stdout', {
                    pid: mongoshell.pid,
                    type: 'stdout',
                    data: data
                });
            }
        });

        mongoshell.stderr.on('data', function (data) {
            if (socketio) {
                socketio.emit('mongoshell.stderr', {
                    pid: mongoshell.pid,
                    type: 'stderr',
                    data: data
                });
            }
        });

        mongoshell.on('close', function (code, signal) {
            if (socketio) {
                socketio.emit('mongoshell.close', {
                    pid: mongoshell.pid,
                    code: code,
                    signal: signal
                });
            }
        });

        mongoshell.on('error', function (code) {

            if (socketio) {
                socketio.emit('mongoshell.error', {
                    pid: mongoshell.pid,
                    code: code
                });
            }
        });

    } catch (err) {
        if (socketio) {
            socketio.emit('mongoshell.error', {
                pid: 0,
                code: err && err.message ? err.message: err
            });
        }
    }

    pub.getPid = function () {
        return mongoshell && mongoshell.pid;
    };

    pub.getInstance = function () {
        return mongoshell;
    };

    pub.write = function (text) {
        mongoshell.stdin.write(text + '\n');
    };

    pub.kill = function () {
        if (mongoshell) {
            if (os.platform() === 'win32') {
                mongoshell.kill();
            } else {
                mongoshell.kill('SIGHUP');
            }
        } else {
            console.log('ERROR: no shell instance');
        }

        return true;
    };

    return pub;
};

var MongoShellHelper = function (io) {
    var globalProcesses = [];
    var pub = {};
    var socketio = io;

    function addProcessToList (ownerid, process) {
        if (process && process.getPid()) {
            globalProcesses.push({
                ownerid: ownerid,
                process: process
            });
        }
    }

    function getMongoShellInstanceFromPid (pid) {
        if (globalProcesses.length === 0) {
            return null;
        }

        for (var i = 0; i < globalProcesses.length; i++) {
            if (globalProcesses[i].process.getPid() === pid) {
                return globalProcesses[i].process;
            }
        }

        return null;
    }

    // create a new process
    function spawnProcess (socket, config) {
        var shellprocess = new MongoShellInstance(socket, config);

        addProcessToList(socket.id, shellprocess);

        return shellprocess;
    }

    function writeProcess (pid, text) {
        if (globalProcesses.length === 0 || !pid || !text) {
            return false;
        }

        for (var i = 0; i < globalProcesses.length; i++) {
            if (globalProcesses[i].process.getPid() === pid) {
                globalProcesses[i].process.write(text);
                return true;
            }
        }

        return false;
    }

    // Terminate a process identified by pid
    function killProcessByPid (pid) {
        var instance = getMongoShellInstanceFromPid(pid);

        if (!instance) {
            return false;
        }

        return instance.kill();
    }

    // Terminates all processes that are started by an id
    function killProcessFromOwnderId (ownderid) {
        if (globalProcesses.length === 0 || !ownderid) {
            return null;
        }

        var kills = 0;

        for (var i = 0; i < globalProcesses.length; i++) {
            if (globalProcesses[i].ownerid === ownderid) {
                globalProcesses[i].process.kill();
                kills++;
            }
        }

        return kills;
    }

    //
    if (socketio) {
        socketio.on('connection', function (socket) {

            socket.on('mongoshell.spawn', function (data, callback) {
                var process = spawnProcess(socket, data);

                callback(null, {pid: process.getPid()});
            });

            socket.on('mongoshell.write', function (data, callback) {
                var result = writeProcess(data.pid, data.text);

                callback(null, {result: result});
            });

            socket.on('mongoshell.kill', function (data, callback) {
                var result = killProcessByPid(data.mongoshellpid);
                callback(null, {result: result});
            });

            socket.on('disconnect', function () {
                killProcessFromOwnderId(socket.id);
            });
        });
    }

    // Kills all
    pub.killAll = function () {

    };

    return pub;
};

var helper = null;

module.exports = {
    create: function (io) {
        helper = new MongoShellHelper(io);
    }
};
