'use strict';

var lxHelpers = require('lx-helpers');
var async = require('async');
var val = require('lx-valid');
var fs = require('fs');
var os = require('os');
var GridStore = require('mongodb').GridStore;
var ObjectID = require('mongodb').ObjectID;
var MongoDb = require('mongodb').Db;
var Server = require('mongodb').Server;
var BSON = require('mongodb').BSON;
var Binary = require('mongodb').Binary;
var Timestamp = require('mongodb').Timestamp;
var Code = require('mongodb').Code;
var MinKey = require('mongodb').MinKey;
var MaxKey = require('mongodb').MaxKey;
var DBRef = require('mongodb').DBRef;
var ReplSetServers = require('mongodb').ReplSetServers;
var path = require('path');
var url = require('url');

module.exports = function (app) {
    var pub = {};
    var CONNECTION_STRING_ERROR_MESSAGE = 'Cannot connect to mongo db. Connection string is wrong or empty';
    var COLLECTION_NAME_ERROR_MESSAGE = 'collection names must be a string and cannot be empty';
    var COLLECTION_FILESTREAM_ERROR_MESSAGE = 'functionality can not be processed because of missing params, use mongoimport/mongoexport instead';
    var REGEX_COLLECTION_NAME_FORBIDDEN_CHARS = /[À-Üß-ü/"*<>:\|\?\x00\\]/g;
    var REGEX_DATABASE_NAME_FORBIDDEN_CHARS = /[À-Üß-ü$\s\. /"*<>:\|\?\x00\\]/g;
    var REGEX_SYSTEM_COLLECTION_NAMES = /system\./;
    var overFlowISODateValue = -9223372036854775808;
    var schemaConnections = {
        type: 'array',
        items: {
            type: 'object',
            required: true,
            properties: {
                connectionString: {
                    type: 'string',
                    required: true,
                    maxLength: 500
                },
                ssh_connectionString: {
                    type: ['null', 'string'],
                    maxLength: 500
                },
                name: {
                    type: 'string',
                    maxLength: 500
                },
                color: {
                    type: 'string',
                    maxLength: 9
                },
                ssh_enabled: {
                    type: 'boolean'
                },
                ssh_host: {
                    type: 'string',
                    maxLength: 100,
                    conform: function (host, data) {
                        return data.ssh_enabled ? host && host.length > 0 : true;
                    }
                },
                ssh_port: {
                    type: ['null', 'integer']
                },
                ssh_local_port: {
                    type: ['null', 'integer']
                },
                ssh_user: {
                    type: 'string',
                    maxLength: 100,
                    conform: function (user, data) {
                        return data.ssh_enabled ? user && user.length > 0 : true;
                    }
                },
                ssh_password: {
                    type: 'string',
                    maxLength: 100
                },
                login_database: {
                    type: 'string',
                    maxLength: 500
                },
                dbName: {
                    type: 'string',
                    maxLength: 500
                },
                is_default_connection: {
                    type: 'boolean'
                },
                slave_ok: {
                    type: 'boolean'
                },
                login: {
                    type: 'string',
                    maxLength: 100
                },
                password: {
                    type: 'string'
                }
            }
        }
    };

    function getUrlQueryOptions (connectionString) {
        if (!lxHelpers.isString(connectionString)) {
            return {};
        }

        var parsed = url.parse(connectionString, true, true);

        return parsed.query || {};
    }

    /**
     * Saves a new connection in the connection file.
     *
     * @param {!object} data The connection data.
     * @param {!object} user The current user.
     * @param {object|function} connectionResult The result of the successfull connection to the server or the callback.
     * @param {function=} callback The callback.
     */
    function saveNewServerConnection (data, user, connectionResult, callback) {
        if (typeof connectionResult === 'function') {
            callback = connectionResult;
            connectionResult = null;
        }

        if (data.isNewConnection && data.connection.connectionString) {
            var newConnection = {
                connectionString: data.connection.connectionString,
                is_default_connection: data.connection.is_default_connection,
                color: data.connection.color,
                name: data.connection.name,
                login_database: data.connection.login_database,
                dbName: data.connection.dbName,
                slave_ok: data.connection.slave_ok
            };

            if (connectionResult && connectionResult.replSetStat) {
                newConnection.replicaSetName = connectionResult.replSetStat.documents[0].set;
            }

            data.savedConnections.push(newConnection);

            saveServerConnections(data.savedConnections, user, function (error) {
                if (callback) {
                    callback(error, true);
                }
            });
        } else if (callback) {
            callback(null, true);
        }
    }

    function canExecuteWriteOperations (db, functionName) {
        var writeOperations = [
            'createDatabase',
            'renameDatabase',
            'copyDatabase',
            'dropDatabase',
            'addCollection',
            'importDocuments',
            'createCollection',
            'renameCollection',
            'importCollection',
            'dropCollection',
            'deleteDocument',
            'saveDocumentInCollection',
            'uploadFile',
            'getDatabaseUsers',
            'setDatabaseUser',
            'removeUserFromDatabase'
        ];

        if (db && db.serverConfig) {
            if (db.serverConfig.servers) {
                // loop throw members, if replica set exists
                var isMaster = false;
                lxHelpers.forEach(db.serverConfig.servers, function (item) {
                    if (item.internalMaster && item.connected) {
                        isMaster = true;
                    }
                });
                return isMaster;

            } else if (db.serverConfig.isMasterDoc) {
                // set right for single instances
                return db.serverConfig.isMasterDoc.ismaster || (!db.serverConfig.isMasterDoc.ismaster && writeOperations.indexOf(functionName) === -1);

            } else {
                return false;
            }

        } else {
            return false;
        }
    }

    /**
     * Add square brackets to string of import
     *
     * @param {!string} text The string of documents
     * @returns {*}
     */
    function addSquareBrackets (text) {
        if (text[0] !== '[') {
            text = '[' + text;
        }

        if (text[0] === '[' && text[text.length - 1] !== ']') {
            text += ']';
        }

        return text;
    }

    /**
     * Check if collection name is a valid collection name
     *
     * @param {string} collectionName The collection name.
     * @returns {boolean}
     */
    function isValidCollectionName (collectionName) {
        // empty collection
        if (!collectionName || collectionName.indexOf('..') !== -1) {
            return false;
        }

        // invalid chars
        if (collectionName.match(REGEX_COLLECTION_NAME_FORBIDDEN_CHARS) || collectionName.search(REGEX_SYSTEM_COLLECTION_NAMES) > -1) {
            return false;
        }

        // $
        if (collectionName.indexOf('$') !== -1 && collectionName.match(/((^\$cmd)|(oplog\.\$main))/) === null) {
            return false;
        }

        // dots at start or end
        if (collectionName.match(/^\.|\.$/) !== null) {
            return false;
        }

        return true;
    }

    /**
     * Check if database name is a valid database name
     *
     * @param {string} dbName The database name.
     * @returns {boolean}
     */
    function isValidDatabaseName (dbName) {
        // empty database name
        if (!dbName) {
            return false;
        }

        // $external is allowed
        if (dbName === '$external') {
            return true;
        }

        // invalid chars
        if (dbName.match(REGEX_DATABASE_NAME_FORBIDDEN_CHARS) || dbName === 'admin' || dbName === 'local') {
            return false;
        }

        return true;
    }

    /**
     * Create the full connection-string including db
     *
     * @param {string} connectionString The connection with server, port.
     * @param {string} dbName The name of the database.
     * @returns {string}
     */
    function getFullConnectionString (connectionString, dbName) {
        return connectionString && lxHelpers.isString(connectionString) && dbName && lxHelpers.isString(dbName) ? connectionString.split('?')[0] + '/' + dbName + '?w=1&journal=True&fsync=True' : null;
    }

    /**
     * Convert id-string to mongo-id
     *
     * @param {*} id The id to convert.
     * @returns {*}
     */
    function getMongoId (id) {
        if (!id) {
            return null;
        }

        if (lxHelpers.isString(id) && val.formats.mongoId(id).valid) {
            return ObjectID.createFromHexString(id);
        }

        if (val.types.mongoId(id).valid) {
            return id;
        }

        return null;
    }

    /**
     * Convert uuid-string to mongo-uuid
     *
     * @param id The uuid-string
     * @param subType The Binary sub_type
     * @param coding The coding for buffer e.g hex
     * @returns {*}
     */

    function getUUID (id, subType, coding) {
        if (!id) {
            return null;
        }

        id = id.replace(/-/g, '');

        return new Binary(new Buffer(id, coding), subType);
    }

    /**
     * Convert timestamp-string to Timestamp
     *
     * @param {!string} timestamp The timestamp-string
     * @param {function=} callback The callback.
     */

    function getTimestamp (timestamp, callback) {
        timestamp = timestamp.replace(/\s/g, '').trim();

        var low = timestamp.substring(timestamp.lastIndexOf(',') + 1);
        var high = timestamp.substring(0, timestamp.lastIndexOf(','));

        // throw an error when low or high is not a number or timestamp is not within the range of timestamps
        if (isNaN(parseInt(low)) || isNaN(parseInt(high)) || new Timestamp(low, high).lessThan(Timestamp.MIN_VALUE) || new Timestamp(low, high).greaterThan(Timestamp.MAX_VALUE)) {
            callback(true, timestamp);
        } else {
            callback(null, new Timestamp(low, high));
        }
    }

    /**
     *  Format UUIDs and LUUIDs for client
     *
     * @param value
     * @returns {string}
     */

    function formatUUIDsForClient (value) {
        value = value.toString('hex');
        return value.slice(0, 8) + '-' + value.slice(8, 12) + '-' + value.slice(12, 16) + '-' + value.slice(16, 20) + '-' + value.slice(20);
    }

    /**
     * Check if collection is GridFS
     *
     * @param {!string} collectionName The name of the collection.
     * @returns {boolean}
     */
    function isGridFSCollection (collectionName) {
        return collectionName.indexOf('.files', collectionName.length - 6) !== -1;
    }

    /**
     * Modify name of collection if GridFS
     *
     * @param {!string} collectionName The name of the collection.
     * @returns {*}
     */
    function getNameOfFilesCollection (collectionName) {
        return isGridFSCollection(collectionName) ? collectionName : collectionName + '.files';
    }

    /**
     * Create collection name of chunks-collection
     *
     * @param {!string} collectionName The name of the collection.
     * @returns {string}
     */
    function getNameOfChunksCollection (collectionName) {
//        if (isGridFSCollection(collectionName)) {
        var result = collectionName.split('.');
        result[result.length - 1] = 'chunks';

        return result.join('.');
//        } else {
//            return collectionName + '.chunks';
//        }
    }

    /**
     * Get the user database
     *
     * @param {object} connection The connection object.
     * @param {!string} connection.server The mongodb-server.
     * @param {!string} connection.port The port of mongodb-instance.
     * @param {!array} dbNames The databases of the connection.
     * @param callback
     */
    function getUserDatabases (connection, dbNames, callback) {
        var databases = [];

        async.eachSeries(dbNames, function (dbObj, next) {
            var db = new MongoDb(dbObj.name, new Server(connection.server, connection.port), {w: 1});

            db.open(function (error, db) {
                if (error || !db) {
                    return next();
                }

                db.authenticate(connection.username, connection.password, {authdb: connection.login_database || 'admin'}, function (err, result) {
                    if (result) {
                        databases.push(dbObj);
                    }

                    db.close(next);
                });
            });
        }, function (error) {
            callback(error, databases);
        });
    }

    /**
     * Get databases from selected server
     *
     * @param {!Object} connection The connection object.
     * @param {!string} connection.server The mongodb-server.
     * @param {!string} connection.port The port of mongodb-instance.
     * @param {boolean} paramForLastElement The param to identify the last element of connections
     * @param callback
     */
    function getDatabasesFromServer (connection, paramForLastElement, callback) {
        var db = new MongoDb(connection.login_database || 'admin', new Server(connection.server, connection.port), {
            w: 1,
            slaveOk: !!connection.slave_ok
        });

        function getDatabases (db) {
            var adminDb = db.admin();

            async.auto({
                    getDatabases: function (next) {
                        adminDb.listDatabases(function (error, result) {
                            if (error) {
                                return next(error, null);
                            }

                            if (result) {
                                if (result.ok === 1 && result.databases) {
                                    result.databases.sort(function (a, b) {
                                        return a.name > b.name ? 1 : -1;
                                    });

                                    next(null, result.databases);
                                } else {
                                    next();
                                }
                            }
                        });
                    },
                    getReplicaSetStat: function (next) {
                        adminDb.command({replSetGetStatus: 'global'}, next);
                    },
                    getMongoVersion: function (next) {
                        adminDb.serverInfo(next);
                    }
                },
                function (error, results) {
                    if (error) {
                        callback(error);
                    } else {
                        callback(null, {
                            databases: results.getDatabases || [
                                {
                                    name: connection.dbName || connection.login_database || 'admin'
                                }
                            ],
                            replSetStat: results.getReplicaSetStat,
                            mongoVersion: results.getMongoVersion.version.slice(0, 4)
                        });
                    }

                    db.close();
                }
            );
        }

        db.open(function (error, db) {
            // throw error, if all members of replica set or a single instance can not connect
            if ((error || !db) && paramForLastElement) {
                return callback(error || 'No DB');
            }
            // skip member of replica set, if connection failed and member is not last member
            else if ((error || !db) && !paramForLastElement) {
                return callback();
            }
            else {
                // authentication
                if (connection.username && connection.password) {
                    db.authenticate(connection.username, connection.password, function (error, result) {
                        if (error || !result) {
                            callback(new app.ControllerError('login failed'));
                        } else {
                            getDatabases(db);
                        }
                    });
                } else {
                    getDatabases(db);
                }
            }
        });
    }

    /**
     * Get connections including list of their databases
     *
     * @param {!object} connectionData.
     * @param {string} connectionData.connectionString The connection as string including server, port.
     * @param callback
     */
    function getServerInformations (connectionData, callback) {
        var isConnected = false;
        var replicaSetName, serverInformations;
        var connections = [];
        var authenticationData = null;

        // get each server of the connection
        lxHelpers.forEach(connectionData.connectionString.split(','), function (item) {
            var pwd = '';

            // remove prefix mongodb://
            item = item.replace(/mongodb:\/\//i, '');

            var connection = item.split(/(.*)@(.*)/g);

            if (connection.length > 1) {
                connection.splice(3, 1);
                connection.splice(0, 1);
            }

            if (connectionData.dbName && !connectionData.login_database) {
                connectionData.login_database = connectionData.dbName;
            }

            var originalPort;
            var conn = {
                login_database: connectionData.login_database,
                dbName: connectionData.dbName
            };

            if (connection.length === 1) {
                // no authentication
                conn.server = connection[0].substring(0, connection[0].lastIndexOf(':'));
                originalPort = connection[0].substring(connection[0].lastIndexOf(':') + 1);

                // check login fields
                if (connectionData.login && connectionData.password) {
                    conn.username = connectionData.login;
                    conn.password = connectionData.password;
                }
            } else {

                // with authentication
                conn.username = connection[0].substring(0, connection[0].indexOf(':'));
//                conn.password = connection[0].substring(connection[0].lastIndexOf(':') + 1);
                conn.server = connection[connection.length - 1].substring(0, connection[connection.length - 1].lastIndexOf(':'));
                originalPort = connection[connection.length - 1].substring(connection[connection.length - 1].lastIndexOf(':') + 1);

                // join password array when password contains @ sign
                for (var i = 0, length = connection.length - 1; i < length; i++) {
                    if (i === 0) {
                        pwd += connection[i].substring(connection[i].indexOf(':') + 1);
                    } else {
                        pwd += connection[i] ? '@' + connection[i] : '@';
                    }
                }

                conn.password = pwd;

                // check login fields
                if (connectionData.login && connectionData.password) {
                    conn.username = connectionData.login;
                    conn.password = connectionData.password;
                }

                authenticationData = conn;
            }

            conn.port = originalPort;

            // clean port
            if (lxHelpers.isString(conn.port) && conn.port.indexOf('/') > -1) {
                conn.port = conn.port.substring(0, conn.port.indexOf('/'));
            }

            // set slave_ok state
            if (connectionData.slave_ok) {
                conn.slave_ok = connectionData.slave_ok;
            }

            connections.push(conn);
        });

        async.each(connections, function (connection, next) {
            getDatabasesFromServer(connection, connections.indexOf(connection) === connections.length - 1, function (error, result) {
                // ignore not available databases in replica set
                if (error) {
                    return callback(convertMongoErrorToClientError(error));
                }

                if (result && result.replSetStat) {
                    isConnected = true;

                    if (connections.length > 1 && result.replSetStat.documents[0].ok === 0) {
                        // return error when server is not replica set member
                        next(new app.ControllerError('The server \'' + connection.server + ':' + connection.port + '\' is not a member of the replica set!'));
                    } else {
                        if (!replicaSetName) {
                            replicaSetName = result.replSetStat.documents[0].set;
                            serverInformations = result;

                            // save master
                            if (connections.length === 1 || result.replSetStat.documents[0].myState === 1) {
                                serverInformations.master = {
                                    server: connection.server,
                                    port: connection.port
                                };
                            }

                            next();
                        } else {
                            if (replicaSetName !== result.replSetStat.documents[0].set) {
                                // return error when use different replica sets
                                next(new app.ControllerError('Trying to connect to different replica sets (\'' + replicaSetName + '\', \'' + result.replSetStat.documents[0].set + '\')'));
                            } else {
                                // override current serverInformations with informations from replica set master
                                if (result.replSetStat.documents[0].myState === 1) {
                                    serverInformations = result;

                                    // save master of replica set
                                    serverInformations.master = {
                                        server: connection.server,
                                        port: connection.port
                                    };
                                }

                                next();
                            }
                        }
                    }
                } else {
                    next();
                }
            });
        }, function (error) {
            if (error || !serverInformations) {
                callback(error || new app.ControllerError('Error loading informations for server.'));
            } else {
                // create databases array
                serverInformations.databases = lxHelpers.arrayMap(serverInformations.databases, function (db) {
                    return {name: db.name, showCollections: false};
                });

                if (authenticationData && !connectionData.dbName) {
                    getUserDatabases(authenticationData, serverInformations.databases, function (error, result) {
                        if (error) {
                            callback(new app.ControllerError(error.message));
                        } else {
                            serverInformations.databases = result;
                            callback(null, serverInformations);
                        }
                    });
                } else {
                    callback(null, serverInformations);
                }
            }
        });
    }

    /**
     * Formatting data to query
     *
     * @param {string} item The query-string.
     * @returns {string}
     */
    function formatingData (item) {
        var data;

        // clear white space
        data = item.replace(/\r|\n/g, '');
        data = data.replace(/\t/g, '');

        data = data.replace(/([\{,]+)([\s]*)([a-zA-Z0-9À-Üß-ü$\-\/\._ ]+):/g, '$1$2$3":'); // add following quotation marks to left curly bracket
        data = data.replace(/([\{,]+)([\s]*)([a-zA-Z0-9À-Üß-ü$\-\/\._]+)([a-zA-Z0-9À-Üß-ü$\-\/\._ ]*)":/g, '$1$2"$3$4":'); // add quotation marks before colon

        data = data.replace(/([\[,:]+)([\s]*)ISODate\("/g, '$1$2"##ISODate(').replace(/([\[,:]+)([\s]*)"##ISODate\(([a-zA-Z0-9À-Üß-ü$\-\/\._:, ]+)"\)/g, '$1$2"##ISODate($3)"'); // reformat ISODate-string
        data = data.replace(/([\[,:]+)([\s]*)ISODate\('/g, '$1$2"##ISODate(').replace(/([\[,:]+)([\s]*)"##ISODate\(([a-zA-Z0-9À-Üß-ü$\-\/\._:, ]+)'\)/g, '$1$2"##ISODate($3)"');

        data = data.replace(/ObjectId\("([a-z0-9-]+)"\)/g, '"##ObjectId($1)"'); // reformat ObjectId-string
        data = data.replace(/LUUID\("([a-z0-9-]+)"\)/g, '"##LUUID($1)"'); // reformat LUUID-string
        data = data.replace(/UUID\("([a-z0-9-]+)"\)/g, '"##UUID($1)"'); // reformat UUID-string
        data = data.replace(/Timestamp\(([0-9,\s]*)\)/g, '"##Timestamp($1)"'); // reformat Timestamp-string

        // reformat regex-string
        // delete unnecessary quotation marks before colon in regex expression
        data = data.replace(/:([\s]*)\/([a-zA-Z0-9À-Üß-ü$\^+\*-\\\._'()\/ ]*)":([a-zA-Z0-9À-Üß-ü$\^+\*-\\\._'()\/ ]*)\//g, ':$1/$2:$3/');
        // modify regex for converting
        data = data.replace(/:([\s]*)\/([a-zA-Z0-9À-Üß-ü$\^+\*-\\\._:'()\/ ]+)\/([a-z]*)/g, ':$1"##/$2/$3"');

//        // replace quotation marks in ISODate (YYYY, MM, dd, hh, mm, ss, ms)
//        data = data.replace(/##ISODate\(([A-Za-z0-9\s]+),"/g, '##ISODate($1,').replace(/##ISODate\(([A-Za-z0-9\s]+),([A-Za-z0-9\s]+),"/g, '##ISODate($1,$2,'); // replace quotation mark in ISODate
//        data = data.replace(/##ISODate\(([0-9\s]+),([0-9\s]+),([0-9\s]+),"/g, '##ISODate($1,$2,$3,'); // before hours
//        data = data.replace(/##ISODate\(([0-9\s]+),([0-9\s]+),([0-9\s]+),([0-9\s]+),"/g, '##ISODate($1,$2,$3,$4,'); // before minutes
//        data = data.replace(/##ISODate\(([0-9\s]+),([0-9\s]+),([0-9\s]+),([0-9\s]+),([0-9\s]+),"/g, '##ISODate($1,$2,$3,$4,$5,'); // before seconds
//        data = data.replace(/##ISODate\(([0-9\s]+),([0-9\s]+),([0-9\s]+),([0-9\s]+),([0-9\s]+),([0-9\s]+),"/g, '##ISODate($1,$2,$3,$4,$5,$6,'); // before milliseconds

        data = data.replace(/'/g, '"'); // replace quotes by quotation marks
        data = data.replace(/"([\s]*)_id([\s]*)"/g, '"_id"'); // delete whitespaces before and after _id
        data = data.replace(/([\s]*)\$/g, '$'); // delete whitespaces before $
        data = data.replace(/"([$a-zA-Z]+)([\s]*)"/g, '"$1"'); // delete whitespaces after $

        data = data.replace(/:([ ]*){/g, ':{'); // delete whitespace between colon and left curly bracket
//        data = data.replace(/""/g, '"'); // replace doubled quotation marks by single quotation marks

        return data;
    }

    /**
     * Create metadata of a document-property
     *
     * @param {*} item The property.
     * @returns {*}
     */
    function populateMetadata (item) {
        var metadata;

        if (val.types.null(item).valid) {
            // null
            metadata = 'null';
        }

        else if (item instanceof Date) {
            // date-time in object-format
            var test = JSON.stringify(item);

            // date-object / date-time
            metadata = test.indexOf(':') > -1 ? 'date-time' : 'date';
        }
        else if (val.types.string(item).valid) {
            // string
            metadata = 'string';

        } else if (val.types.number(item).valid) {
            // number
            if (val.types.integer(item).valid) {
                metadata = 'integer';
            } else {
                metadata = 'float';
            }

        } else if (val.types.boolean(item).valid) {
            // boolean
            metadata = 'boolean';

        } else if (val.formats.regex(item).valid) {
            // boolean
            metadata = 'regex';

        } else if (val.types.array(item).valid) {
            // array
            if (item.length === 0) {
                metadata = 'array';
            } else {
                metadata = [];
                item.map(function (arrItem) {
                    if (arrItem && arrItem._bsontype) {
                        // ObjectId
                        metadata.push(arrItem._bsontype);
                    } else {
                        // recursion for array
                        metadata.push(populateMetadata(arrItem));
                    }
                });
            }

        } else if (val.types.object(item).valid) {
            if (item._bsontype) {
                // ObjectId
                if (item.sub_type) {
                    switch (item.sub_type) {
                        case 3:
                            metadata = 'LUUID';
                            break;
                        case 4:
                            metadata = 'UUID';
                            break;
                        default:
                            metadata = item._bsontype;
                    }
                } else {
                    // ObjectId
                    metadata = item._bsontype;
                }
            } else {
                // recursion for object
                var key;
                metadata = {};
                for (key in item) {
                    if (item.hasOwnProperty(key)) {
                        metadata[key] = populateMetadata(item[key]);
                    }
                }
            }

        }

        return metadata;
    }

    /**
     * Get date value of formatted date-string
     *
     * @param value The formatted date-string
     * @param {!function(error, result)} callback The callback.
     * @returns {*}
     */
    function extractValueOfDateString (value, callback) {
        var result = value.replace('##ISODate(', '').replace(')', '');
        var date;

        // set current Date if value is empty
        if (result.length === 0) {
            result = new Date().toISOString();
        }

        // check if value is valid date format and throw error if not
        if (!(val.formats.dateTime(result).valid || val.formats.date(result).valid || val.formats.time(result).valid || val.formats.utcMillisec(parseInt(result)).valid)) {
            return callback(true, result);
        } else {
            // replace whitespaces and parse value
            result = result.replace(/\s/g, '');

            // (YYYY, MM, dd, hh, mm, ss, ms)
            if (parseInt(result.split(',')[0]) && parseInt(result.split(',')[1]) && parseInt(result.split(',')[2])) {
                date = new Date(
                    parseInt(result.split(',')[0]),         // year
                    parseInt(result.split(',')[1] - 1),     // month
                    parseInt(result.split(',')[2]),         // day
                    parseInt(result.split(',')[3]) || 0,    // hours
                    parseInt(result.split(',')[4]) || 0,    // minutes
                    parseInt(result.split(',')[5]) || 0,    // seconds
                    parseInt(result.split(',')[6]) || 0);   // miliseconds
            } else if (parseInt(result) && result.indexOf('.') === -1) {
                // timestamp
                date = new Date(parseInt(result));
            } else {
                // (YYYY-MM-ddThh:mm:ss.000Z or MM dd, YYYY)
                date = new Date(result);
            }
        }

        callback(null, date);
    }

    /**
     * Convert date-time-properties and ids to save
     *
     * @param {*} data The document or property to check.
     * @param {!object} metadata The metadata of a collection.
     * @param {string=} option The indicator for imported data or data to validate.
     * @param {!function(error, result)} callback The callback.
     */
    function convertDateTimeAndIdsInDocumentToSave (data, metadata, option, callback) {
        metadata = metadata || {};
        var error = null;

        lxHelpers.forEach(data, function (value, key) {
            if (lxHelpers.isObject(value) || lxHelpers.isArray(value)) {
                if (!(value && (value.$oid || value.$date))) {
                    convertDateTimeAndIdsInDocumentToSave(value, metadata[key], option, function (err, res) {
                        if (err) {
                            error = error || err;
                        }
                        value = res;
                    });
                }
            }

            // get id from data import via file
            if (value && value.$oid && option === 'fileUpload') {
                data[key] = getMongoId(value.$oid);
            }
            // get date object from data import via file
            else if (value && (value.$date || value.$date === null || value.$date === 0) && option === 'fileUpload') {
                // if value invalid date create invalid date ---> mongodb js driver converts to 1.1.1970
                if (value.$date === overFlowISODateValue) {
                    data[key] = new Date('Invalid Date');
                } else {
                    data[key] = new Date(value.$date);
                }
            }

            // get data of binay from data import via file
            else if (value && value.$binary && option === 'fileUpload') {
                // get UUID or NUUID
                if (value.$type && (value.$type === '03' || value.$type === '04')) {
                    data[key] = getUUID(value.$binary, parseInt(value.$type), 'base64');
                }
            }

            // get regex from data import via file
            else if (value && value.$regex && option === 'fileUpload') {
                data[key] = new RegExp(value.$regex, value.$options);
            }

            // get timestamp from data import via file
            else if (value && value.$timestamp && option === 'fileUpload') {
                data[key] = new Timestamp(value.$timestamp.i, value.$timestamp.t);
            }

            // get Code from data import via file
            else if (value && value.$code && option === 'fileUpload') {
                data[key] = new Code(value.$code, value.$scope || {});
            }

            // get DBRef from data import via file
            else if (value && value.$ref && option === 'fileUpload') {
                data[key] = new DBRef(value.$ref, value.$id, value.$db || null);
            }

            // get id-String from text-document
            else if (value && val.types.string(value).valid && value.indexOf('##ObjectId(') === 0) {
                if (val.formats.mongoId(value.replace('##ObjectId(', '').replace(')', '')).valid || option === 'toValidate') {
                    data[key] = option === 'toValidate' ? value.replace('##ObjectId(', '').replace(')', '') : getMongoId(value.replace('##ObjectId(', '').replace(')', ''));
                } else {
                    error = {message: 'Value "' + value.replace('##ObjectId(', '').replace(')', '') + '" of key "' + key + '" is no valid ObjectId, please check your input.'};
                }
            }

            // get UUID-String from text-document
            else if (value && val.types.string(value).valid && value.indexOf('##UUID(') === 0) {
                if (val.formats.uuid(value.replace('##UUID(', '').replace(')', '')).valid || option === 'toValidate') {
                    data[key] = option === 'toValidate' ? value.replace('##UUID(', '').replace(')', '') : getUUID(value.replace('##UUID(', '').replace(')', ''), 4, 'hex');
                } else {
                    error = {message: 'Value "' + value.replace('##UUID(', '').replace(')', '') + '" of key "' + key + '" is no valid UUID, please check your input.'};
                }
            }

            // get LUUID-String from text-document
            else if (value && val.types.string(value).valid && value.indexOf('##LUUID(') === 0) {
                if (val.formats.luuid(value.replace('##LUUID(', '').replace(')', '')).valid || option === 'toValidate') {
                    data[key] = option === 'toValidate' ? value.replace('##LUUID(', '').replace(')', '') : getUUID(value.replace('##LUUID(', '').replace(')', ''), 3, 'hex');
                } else {
                    error = {message: 'Value "' + value.replace('##LUUID(', '').replace(')', '') + '" of key "' + key + '" is no valid LUUID, please check your input.'};
                }
            }

            // get Timestamp-String from text-document
            else if (value && val.types.string(value).valid && value.indexOf('##Timestamp(') === 0) {
                if (option === 'toValidate') {
                    data[key] = value.replace('##Timestamp(', '').replace(')', '').trim();
                } else {
                    getTimestamp(value.replace('##Timestamp(', '').replace(')', ''), function (err, timestamp) {
                        if (err) {
                            error = {message: 'Value "' + timestamp + '" of key "' + key + '" is no valid timestamp, please check your input (high-bit-value, low-bit-value).'};
                        } else {
                            data[key] = timestamp;
                        }
                    });
                }
            }

            // get Code object from text-document
            else if (value && lxHelpers.isObject(value) && value.$code) {
                data[key] = new Code(value.$code, value.$scope || {});
            }

            // get MinKey object from text-document
            else if (value && lxHelpers.isObject(value) && value.$minKey) {
                data[key] = new MinKey();

            }

            // get MaxKey object from text-document
            else if (value && lxHelpers.isObject(value) && value.$maxKey) {
                data[key] = new MaxKey();
            }

            // get DBRef object from text-document
            else if (value && lxHelpers.isObject(value) && value.$id && value.$ref) {
                data[key] = new DBRef(value.$ref, value.$id, value.$db || null);
            }

            // get date object or date string from text-document
            else if (value && val.types.string(value).valid && value.indexOf('##ISODate(') === 0) {
                if (option === 'toValidate') {
                    data[key] = value.replace('##ISODate(', '').replace(')', '');
                } else {
                    extractValueOfDateString(value, function (err, date) {
                        if (err) {
                            error = {message: 'Value "' + date + '" of key "' + key + '" is no valid date, please check your input.'};
                        } else {
                            data[key] = date;
                        }
                    });
                }
            }
            // get regex from text-document
            else if (value && val.types.string(value).valid && value.indexOf('##/') === 0) {
                var regExValueExp = value.substr(0, value.match(/\/([a-z]*)$/).index).replace(/\##\//g, '');
                var regExValueParam = value.substr(value.match(/\/([a-z]*)$/).index + 1);
                try {
                    data[key] = new RegExp(regExValueExp, regExValueParam);
                } catch (err) {
                    data[key] = undefined;
                }
            }
        });

        callback(error, data);
    }

    /**
     * Convert date-time-properties to export
     *
     * @param {*} data The document or property to check.
     * @returns {*}
     */
    function convertValuesForExport (data) {
        lxHelpers.forEach(data, function (value, key) {
            if (lxHelpers.isObject(value) || lxHelpers.isArray(value)) {
                convertValuesForExport(value);
            }

            if (value && value instanceof Date) {
                var checkValue = JSON.stringify(value).replace(/"/g, '');
                // check if value is valid date format and set overFlowISODateValue if is not
                if (!(val.formats.dateTime(checkValue).valid || val.formats.date(checkValue).valid || val.formats.time(checkValue).valid || val.formats.utcMillisec(parseInt(checkValue)).valid)) {
                    data[key] = {$date: overFlowISODateValue};
                } else {
                    data[key] = {$date: value.getTime()};
                }
            }

            if (value && val.types.mongoId(value).valid) {
                data[key] = {$oid: value};
            }

            if (value && val.types.regexp(value).valid) {
                var regexValue = value.toString().split('/');
                var regexExp = '';

                if (regexValue.length > 3) {
                    // if regex expression contains backslashes
                    regexExp += regexValue[1];
                    for (var i = 2; i < regexValue.length - 1; i++) {
                        regexExp += '/' + regexValue[i];
                    }
                } else {
                    regexExp = regexValue[1];
                }

                data[key] = {
                    $regex: regexExp,
                    $options: regexValue[regexValue.length - 1]
                };
            }

            // Binary data
            if (value && value._bsontype && value._bsontype === 'Binary' && value.sub_type) {
                switch (value.sub_type) {
                    case 3:
                        data[key] = {$binary: value.toString('base64'), $type: '03'};
                        break;
                    case 4:
                        data[key] = {$binary: value.toString('base64'), $type: '04'};
                        break;
                }
            }

            // Timestamp
            if (value && value._bsontype && value._bsontype === 'Timestamp') {
                data[key] = {
                    $timestamp: {
                        t: value.high_,
                        i: value.low_
                    }
                };
            }

            // Code
            if (value && value._bsontype && value._bsontype === 'Code') {
                data[key] = {
                    $code: value.code,
                    $scope: value.scope
                };
            }

            // DBRef
            if (value && value._bsontype && value._bsontype === 'DBRef') {
                data[key] = {
                    $ref: value.namespace,
                    $id: value.oid
                };

                if (value.db) {
                    data[key].$db = value.db;
                }
            }

            // MinKey
            if (value && value._bsontype && value._bsontype === 'MinKey') {
                data[key] = {$minKey: 1};
            }

            // MaxKey
            if (value && value._bsontype && value._bsontype === 'MaxKey') {
                data[key] = {$maxKey: 1};
            }
        });

        return data;
    }

    /**
     * Convert ids and date objects for client
     *
     * @param {*} data The document or property to check.
     * @returns {*}
     */
    function convertValuesOfDocumentsForClient (data) {
        lxHelpers.forEach(data, function (value, key) {
            // ISODate
            if (value && value instanceof Date) {
                var parsedDate;

                try {
                    parsedDate = value.toISOString();
                } catch (e) {
                    parsedDate = value === overFlowISODateValue ? value : value.toString();
                }

                data[key] = 'ISODate(' + parsedDate + ')';
                return;
            }

            // ObjectId
            if (value && val.types.mongoId(value).valid && !val.types.string(value).valid) {
                data[key] = 'ObjectId(' + value + ')';
                return;
            }

            // regex
            if (value && val.formats.regex(value).valid) {
                data[key] = '##' + value;
                return;
            }

            // Binary data
            if (value && value.sub_type) {
                switch (value.sub_type) {
                    case 3:
                        data[key] = 'LUUID(' + formatUUIDsForClient(value) + ')';
                        break;
                    case 4:
                        data[key] = 'UUID(' + formatUUIDsForClient(value) + ')';
                        break;
                }
            }

            // Timestamp
            if (value && value._bsontype && value._bsontype === 'Timestamp') {
                data[key] = 'Timestamp(' + value.high_ + ', ' + value.low_ + ')';
            }

            // Code
            if (value && value._bsontype && value._bsontype === 'Code') {
                data[key] = {
                    $code: value.code,
                    $scope: value.scope
                };
            }

            // MinKey
            if (value && value._bsontype && value._bsontype === 'MinKey') {
                data[key] = {
                    $minKey: 1
                };
            }

            // MaxKey
            if (value && value._bsontype && value._bsontype === 'MaxKey') {
                data[key] = {
                    $maxKey: 1
                };
            }

            // DBRef
            if (value && value._bsontype && value._bsontype === 'DBRef') {
                data[key] = {
                    $ref: value.namespace,
                    $id: val.types.mongoId(value.oid).valid && !val.types.string(value.oid).valid ? 'ObjectId(' + value.oid + ')' : value.oid
                };

                if (value.db) {
                    data[key].$db = value.db;
                }

            }

            if (lxHelpers.isObject(value) || lxHelpers.isArray(value)) {
                convertValuesOfDocumentsForClient(value);
            }
        });
        return data;
    }

    /**
     * Save Document in collection
     *
     * @param {!object} data The data including document.
     * @param {string} data.id The id of the document if exists.
     * @param {object} data.data The document to save.
     * @param {boolean} data.setIsEnabled The parameter for kind of update.
     * @param {!string} data.collectionName The name of the collection.
     * @param {!function(result)} callback The callback.
     */
    function saveDocumentInCollection (data, callback) {
        var db;

        function clientCallback (error, result) {
            if (error) {
                callback(new app.ControllerError(error.message));
            } else {
                callback(null, result);
            }

            if (db) {
                db.close();
            }
        }

        connectToDatabase(data, 'saveDocumentInCollection', function (error, openDb) {
            if (error) {
                return callback(convertMongoErrorToClientError(error));
            }

            db = openDb;

            try {
                if (data.id) {
                    // delete data._id otherwise you cannot update
                    if ((data.id || '').toString() === (data.data._id || '').toString()) {
                        delete data.data._id;
                    }

                    var id = val.formats.mongoId(data.id).valid && data.metadata && data.metadata._id === 'ObjectID' ? getMongoId(data.id) : data.id;

                    var document = data.setIsEnabled ? {$set: data.data} : data.data;

                    db.collection(data.collectionName).update({_id: id}, document, {w: 1}, clientCallback);
                } else {
                    db.collection(data.collectionName).insert(data.data, {w: 1}, clientCallback);
                }
            } catch (e) {
                clientCallback(e);
            }
        });
    }

    /**
     * Save server-connections in file.
     *
     * @param {Array} serverConnections The connection-object.
     * @param {!Object} user The user-object from the session.
     * @param {!function(result)} callback The callback.
     */
    function saveServerConnections (serverConnections, user, callback) {
        var schema = schemaConnections;

        var validationOptions = {
            unknownProperties: 'delete',
            trim: true,
            strictRequired: true
        };

        var validation = val.validate(serverConnections, schema, validationOptions);

        if (!validation.valid) {
            return callback(new app.ValidationError(validation.errors));
        }

        var pathToConnectionsFolder = path.join(app.config.path.appDataRoot, 'connections');

        async.waterfall([
            function (next) {
                fs.exists(pathToConnectionsFolder, function (result) {
                    next(null, result);
                });
            },
            function (folderExists, next) {
                if (!folderExists) {
                    fs.mkdir(pathToConnectionsFolder, next);
                } else {
                    next();
                }
            },
            function (next) {
                var connectionsAsString = JSON.stringify(serverConnections).replace(/([a-zA-Z0-9-._: ]+)':/g, '\'$1\':').replace(/'/g, '"');
                fs.writeFile(path.join(pathToConnectionsFolder, user.name + '.json'), connectionsAsString, next);
            }
        ], function (error) {
            callback(error, !error);
        });
    }

    /**
     * Convert MongoIds in query
     *
     * @param {object} query The documents from client.
     **/
    function convertMongoIdsInQuery (query) {
        lxHelpers.forEach(query, function (value, key) {
            if (lxHelpers.isObject(value) || lxHelpers.isArray(value)) {
                convertMongoIdsInQuery(value);
            }

            if (lxHelpers.isString(value) && val.formats.mongoId(value).valid) {
                query[key] = ObjectID.createFromHexString(value);
            }
        });

        return query;
    }

    /**
     * Copy database
     *
     * @param {!object} server The server object.
     * @param {!string} server.server The server name.
     * @param {!number} server.port The server port.
     * @param {!string} oldDbName The old db name.
     * @param {!string} newDbName The new db name.
     * @param {!function(error, result)} callback The callback.
     */
    function copyDatabase (server, oldDbName, newDbName, callback) {
        if (!server || !server.server || !lxHelpers.isString(server.server) || !server.port || !lxHelpers.isString(server.port)) {
            return callback({message: 'server is invalid'});
        }

        var db = new MongoDb(oldDbName, new Server(server.server, parseInt(server.port)), {w: 1});

        db.open(function (error, db) {
            if (error || !db) {
                return callback(new app.ControllerError(error.message || 'No DB'));
            }

            // throw an error while trying to copy a database on slave
            if (!canExecuteWriteOperations(db, 'copyDatabase')) {
                db.close();
                return callback({message: 'mongoDB-instance is not a master, only read operations are possible'});
            }

            var adminDb = db.admin();

            // copy selected database
            adminDb.command({copydb: 1, fromdb: oldDbName, todb: newDbName}, function (error, result) {
                callback(error, result);
                db.close();
            });
        });
    }

    /**
     * Check if index is not element of collection-indexes
     *
     * @param {array} array The list of collection-indexes.
     * @param {!string} field The field of new index to check.
     * @param {!string} fieldName The Name of field to check.
     * @param {!string} originName The origin name of selected index.
     * @returns {boolean}
     */
    function nameNotExistsInIndexArray (array, field, fieldName, originName) {
        var i;
        var length = array.length;
        var exists = true;

        for (i = 0; i < length; i++) {
            var existingField = array[i][fieldName];

            if ((existingField === field || JSON.stringify(existingField) === JSON.stringify(field)) && array[i].name !== originName) {
                exists = false;
                break;
            }
        }

        return exists;
    }

    /**
     * Create array of members of replica set
     *
     * @param {!string} connection The connection string
     * @returns {Array}
     */
    function getArrayOfReplicaSetMembers (connection) {
        var arrayOfMembers = [],
            connectionArray = connection.split('/')[0];

        connectionArray = connectionArray.split(',');

        lxHelpers.forEach(connectionArray, function (item) {
            arrayOfMembers.push({server: item.split(':')[0], port: item.split(':')[1]});
        });

        return arrayOfMembers;
    }

    /**
     * Get all necessary informations from connection string
     *
     * @param {!string} connectionString The string including server, port.
     * @returns {{}}
     */
    function getConnectionFromConnectionString (connectionString) {
        var result = {};

        // remove prefix mongodb://
        connectionString = connectionString.replace(/mongodb:\/\//i, '');

        var connection = connectionString.split(/(.*)@(.*\/.*)/g);

        if (connection.length > 1) {
            connection.splice(3, 1);
            connection.splice(0, 1);
        }

        // todo parse mongo options from connection string

        if (connection.length === 1) {
            // no authentication
            if (connection[0].split(':').length === 2) {
                result.server = connection[0].substring(0, connection[0].lastIndexOf(':'));
                result.port = connection[0].substring(connection[0].lastIndexOf(':') + 1, connection[0].lastIndexOf('/'));
            } else {
                // if connection is replica set
                result.replSetMembers = getArrayOfReplicaSetMembers(connection[0]);
            }
        } else {
            // with authentication
            result.username = connection[0].substring(0, connection[0].lastIndexOf(':'));
            result.password = connection[0].substring(connection[0].lastIndexOf(':') + 1);

            if (connection[1].split(':').length === 2) {
                result.server = connection[1].substring(0, connection[1].lastIndexOf(':'));
                result.port = connection[1].substring(connection[1].lastIndexOf(':') + 1, connection[1].lastIndexOf('/'));
            } else {
                // if connection is replica set
                result.replSetMembers = getArrayOfReplicaSetMembers(connection[1]);
            }
        }

        return result;
    }

    /**
     * Connect to selected database
     *
     * @param {object} data The connection object.
     * @param {!string} data.connectionString The connection including server, port.
     * @param {!string} functionName The name of the function which wants to connect.
     * @param {!string} data.dbName The name of the database.
     * @param callback
     * @returns {*}
     */
    function connectToDatabase (data, functionName, callback) {
        data = data || {};
        var db;
        var fullConnectionString = getFullConnectionString(data.connectionString, data.dbName);
        var replicaSetConnections = [];
        var singleInstance;

        if (!fullConnectionString) {
            return callback(new Error(CONNECTION_STRING_ERROR_MESSAGE));
        }

        var connection = getConnectionFromConnectionString(fullConnectionString);

        // overide login
        if (data.login && data.password) {
            connection.username = data.login;
            connection.password = data.password;
        }

        var connectionOptions = getUrlQueryOptions(data.connectionString);

        // set options i.e. read preferences of slaves in a replica set
        var options = {
            w: 1,
            //slave_ok: data.connectionString.substring(data.connectionString.lastIndexOf('?') + 1).split('=')[1] === 'true'
            slave_ok: Boolean(connectionOptions.slave_ok)
        };

        var serverOptions = {};

        // check if connection is replica set
        if (connection.replSetMembers) {
            lxHelpers.forEach(connection.replSetMembers, function (item) {
                var server = new Server(item.server, item.port);
                replicaSetConnections.push(server);

                // set replica set name
                if (connectionOptions.replicaSet) {
                    serverOptions.replicaSet = connectionOptions.replicaSet;
                }
            });
        } else {
            // if connection is single instance
            singleInstance = new Server(connection.server, connection.port);
        }

        db = new MongoDb(data.dbName, connection.replSetMembers ? new ReplSetServers(replicaSetConnections, serverOptions) : singleInstance, options);

        async.auto({
                openDb: function (next) {
                    db.open(function (error, openDb) {
                        if (error) {
                            return next(new app.ControllerError(error.message));
                        }

                        if (!canExecuteWriteOperations(openDb, functionName || '')) {
                            openDb.close();
                            return next({message: 'mongoDB-instance is not a master, only read operations are possible'});
                        }

                        if (connection.username && connection.password) {
                            openDb.authenticate(connection.username, connection.password, {authdb: data.login_database || 'admin'}, function (err, auth) {
                                if (auth) {
                                    next(err, openDb);
                                } else {
                                    next(new Error('login failed'));
                                }
                            });
                        } else {
                            next(null, openDb);
                        }
                    });
                },
                getVersionOfMongoDB: ['openDb', function (next, results) {
                    if (results.openDb) {
                        var adminDb = db.admin();

                        adminDb.serverInfo(function (err, stats) {
                            results.openDb.mongoVersion = stats && stats.version ? stats.version.slice(0, 4) : null;
                            next();
                        });
                    } else {
                        next();
                    }
                }]
            },
            function (error, results) {
                if (error) {
                    return callback(new app.ControllerError(error.message));
                }
                else {
                    callback(null, results.openDb);
                }
            }
        );
    }

    /**
     * Check size of calculated package for import or insert
     *
     * @param {!Array} packageArray The package with documents as items.
     * @param {number} packageLimitInMB The limit of a package in mb
     * @returns {*}
     */
    function setPackageSizeOfDocuments (packageArray, packageLimitInMB) {
        if (BSON.calculateObjectSize(packageArray) / 1024 / 1024 > packageLimitInMB) {
            packageArray = setPackageSizeOfDocuments(packageArray.slice(0, packageArray.length / 2), packageLimitInMB);
        }
        return packageArray;
    }

    /**
     * Splits Array of documents if BSON-size is to large
     *
     * @param {Array} documentsArray The array with documents.
     * @returns {Array}
     */
    function splitDocumentsArrayToPackages (documentsArray) {
        var arraySize = BSON.calculateObjectSize(documentsArray) / 1024 / 1024,
            packageLimitInMB = 15,
            firstSliceElement = 0,
            count = 0,
            packageArray = [];

        if (arraySize > packageLimitInMB) {
            // get average number of documents for packages
            var numberOfDocumentsInPackage = Math.round((packageLimitInMB * documentsArray.length) / arraySize);

            do {
                // get array of documents with size less than 16 mb
                var packageArrayElement = setPackageSizeOfDocuments(documentsArray.slice(firstSliceElement, firstSliceElement + numberOfDocumentsInPackage), packageLimitInMB);

                // set slice parameter for next loop
                firstSliceElement += packageArrayElement.length;
                count += packageArrayElement.length;

                // push package in array for insert
                packageArray.push(packageArrayElement);
            } while (count < documentsArray.length);
        } else {
            packageArray.push(documentsArray);
        }

        return packageArray;
    }

    /**
     * Converts a mongo error object to a client error object. If error is null then returns null
     *
     * @param {*} error
     * @returns {object|null}
     */
    function convertMongoErrorToClientError (error) {
        if (error) {
            if (error instanceof app.ControllerError || error instanceof app.ValidationError) {
                return error;
            }

            return new app.ControllerError('Mongo Error: ' + (error.message || 'Unknow Mongo Error'));
        } else {
            return null;
        }
    }

    /**
     * Modify string for export
     *
     * @param {!string} data The string of documents to export
     * @returns {string}
     */
    function replaceForExport (data) {
        data = data.replace(/{/g, '{ ').replace(/":/g, '" : ').replace(/\}/g, ' }').replace(/,/g, ', ').replace(/\[/g, '[ ').replace(/\]/g, ' ]');
        return data;
    }

    /**
     * Modify string of import to convert
     *
     * @param {!string} data The json-string of import
     * @returns {string}
     */
    function replaceForImport (data) {
        data = addSquareBrackets(data);
        data = data.replace(/}\r\n\{/g, '},{').replace(/}\n\{/g, '},{').replace(/}\r\{/g, '},{').replace(/,]/g, ']');

        // convert NumberInt to string for parsing (Mongo Version > 3.0)
        data = data.replace(/NumberInt\(([0-9]+)\)/g, '$1');
        return data;
    }

    /**
     * Build string of data to export
     *
     * @param {!object} data The document
     * @param {!string} string The string to cache
     * @returns {string}
     */
    function prepareDocumentsForExport (data) {
        return replaceForExport(JSON.stringify(convertValuesForExport(data))) + '\r\n';
    }

    /**
     * Build schema for object properties in indexes
     *
     * @param {!object} schemaValue The key- or weights-object
     * @returns {{}}
     */
    function getPropertiesOfIndexObjectFields (schemaValue) {
        var propertyObject = {},
            key;

        function conformString (value) {
            if (lxHelpers.isString(value)) {
                return value === 'text';
            } else {
                return true;
            }
        }

        for (key in schemaValue) {
            if (schemaValue.hasOwnProperty(key)) {
                propertyObject[key] = {
                    type: ['integer', 'string'],
                    conform: conformString,
                    messages: {
                        conform: 'string indexes must contain the string "text"'
                    }
                };
            }
        }

        return propertyObject;
    }

    /**
     * Extract single values from arrays of request data values (upload/import)
     *
     * @roles UsersWithAccess, Admin
     * @description Extract single values from arrays of request data values (upload/import)
     *
     * @param {object} data The object form request of upload and import
     * @returns {{}}
     */
    pub.convertDataFromRequestForApp = function (data) {
        var convertedData = {};

        lxHelpers.forEach(data, function (value, key) {
            convertedData[key] = value[0];
        });

        return convertedData;
    };

    /**
     * Gets saved connections
     *
     * @roles UsersWithAccess, Admin
     * @description Gets saved connections
     *
     * @param {object} data The object with connection-array.
     * @param {!object} request The request object.
     * @param {!function(err, res)} request.getSession Returns the current session object.
     * @param {!function(result)} callback The callback.
     */
    pub.getServerConnections = function (data, request, callback) {
        var currentPath = path.join(app.config.path.appDataRoot, 'connections', request.session.user.name + '.json');

        fs.readFile(currentPath, {encoding: 'utf8'}, function (error, result) {
            if (result) {
                try {
                    result = JSON.parse(result);
                    callback(null, result);
                }
                catch (err) {
                    app.loggers.syslog.warn('connections: Problem reading connections file of user %s', request.session.user.name);
                    app.loggers.syslog.warn(err);

                    if (err.message && err.message.indexOf('Unexpected token') > -1) {
                        app.loggers.syslog.warn('connections: File will be deleted: %s', currentPath);

                        // delete file when it cannot be parsed
                        return fs.unlink(path.join(currentPath), callback(null, []));
                    }

                    callback(null, result);
                }
            } else {
                callback(null, []);
            }
        });
    };

    /**
     * Change saved server-connections by deleting an element.
     *
     * @roles UsersWithAccess, Admin
     * @description Change saved server-connections by deleting an element
     *
     * @param {object} data The connections.
     * @param {!object} request The request object.
     * @param {!function(err, res)} request.getSession Returns the current session object.
     * @param {!function(result)} callback The callback.
     */
    pub.changeServerConnections = function (data, request, callback) {
        data = data || {};

        if (!data.connections || !lxHelpers.isArray(data.connections)) {
            return callback(new app.ControllerError('Cannot save connections. Connections are empty or no string'));
        }

        saveServerConnections(data.connections, request.session.user, callback);
    };

    /**
     * Gets all databases from server.
     *
     * @roles UsersWithAccess, Admin
     * @description Gets all databases from server
     *
     * @param {object} data The query.
     * @param {!object} request The request object.
     * @param {!function(err, res)} request.getSession Returns the current session object.
     * @param {!function(result)} callback The callback.
     */
    pub.getServerInformations = function (data, request, callback) {
        getServerInformations(data.connection, function (error, result) {
            saveNewServerConnection(data, request.session.user, result, function (saveFileError) {
                if (error) {
                    callback(convertMongoErrorToClientError(error));
                } else {
                    var clientResult = {
                        connectionString: data.connection.connectionString,
                        databases: result.databases || [],
                        replSetStat: result.replSetStat.documents[0] || {},
                        master: result.master,
                        slave_ok: data.connection.slave_ok,
                        mongoVersion: result.mongoVersion,
                        login_database: data.connection.login_database,
                        connectionTitle: result.master.server + ':' + result.master.port,
                        login: data.connection.login,
                        password: data.connection.password
                    };

                    if (saveFileError) {
                        clientResult.error = saveFileError;
                    }

                    callback(null, clientResult);
                }
            });

            //if (error) {
            //    callback(convertMongoErrorToClientError(error));
            //} else {
            //    var clientResult = {
            //        connectionString: data.connection.connectionString,
            //        databases: result.databases || [],
            //        replSetStat: result.replSetStat.documents[0] || {},
            //        master: result.master,
            //        slave_ok: data.connection.slave_ok,
            //        mongoVersion: result.mongoVersion,
            //        connectionTitle: result.master.server + ':' + result.master.port
            //    };
            //
            //    // if new server-connection is detected
            //    if (data.isNewConnection && data.connection.connectionString) {
            //        var newConnection = {
            //            connectionString: data.connection.connectionString,
            //            replicaSetName: result.replSetStat.documents[0].set,
            //            is_default_connection: data.connection.is_default_connection,
            //            color: data.connection.color,
            //            name: data.connection.name,
            //            login_database: data.connection.login_database,
            //            dbName: data.connection.dbName,
            //            slave_ok: data.connection.slave_ok
            //        };
            //
            //        data.savedConnections.push(newConnection);
            //
            //        saveServerConnections(data.savedConnections, request.session.user, function (error) {
            //            if (error) {
            //                clientResult.error = error;
            //            }
            //
            //            callback(null, clientResult);
            //        });
            //    } else {
            //        callback(null, clientResult);
            //    }
            //}
        });
    };

    /**
     * Returns all databases.
     *
     * @roles UsersWithAccess, Admin
     * @description Returns all databases.
     *
     * @param {object} data The connection-object.
     * @param {!string} data.connectionString The connection string.
     * @param {Array<string>=} data.expandedDatabases The names of the databases which collections should be loaded.
     * @param {!object} request The request object.
     * @param {!function(err, res)} request.getSession Returns the current session object.
     * @param {!function(error, result)} callback The callback.
     */
    pub.getDatabases = function (data, request, callback) {
        data = data || {};

        if (!data.connectionString || !lxHelpers.isString(data.connectionString)) {
            return callback(convertMongoErrorToClientError(new app.ControllerError(CONNECTION_STRING_ERROR_MESSAGE)));
        }

        data.connectionString = data.connectionString.slice(0, data.connectionString.lastIndexOf('?'));

        getServerInformations(data, function (error, result) {
            if (error) {
                callback(error);
            } else {
                var clientResult = {
                    databases: result.databases || [],
                    replSetStat: result.replSetStat.documents[0] || {}
                };

                async.each(data.expandedDatabases || [], function (dbName, next) {
                    var database = lxHelpers.arrayFirst(clientResult.databases, function (db) {
                        return db.name === dbName;
                    });

                    if (database) {
                        pub.getAllCollectionsNamesFromDatabase({
                            connectionString: data.connectionString,
                            dbName: dbName,
                            login_database: data.login_database,
                            login: data.login,
                            password: data.password
                        }, request, function (error, result) {
                            if (error) {
                                next(error);
                            } else {
                                database.showCollections = true;
                                database.collections = result || [];
                                next();
                            }
                        });
                    } else {
                        next();
                    }
                }, function (error) {
                    if (error) {
                        callback(error);
                    } else {
                        callback(null, clientResult);
                    }
                });
            }
        });
    };

    /**
     * Create a new database on selected server.
     *
     * @roles UsersWithAccess, Admin
     * @description Create a new database on selected server
     *
     * @param {object} data The connection-object.
     * @param {!string} data.connectionString The connection string.
     * @param {!string} data.dbName The database name.
     * @param {!object} request The request object.
     * @param {!function(err, res)} request.getSession Returns the current session object.
     * @param {!function(error, result)} callback The callback.
     */
    pub.createDatabase = function (data, request, callback) {
        data = data || {};

        if (!isValidDatabaseName(data.dbName)) {
            return callback(new app.ControllerError('Database name "' + data.dbName + '" is not a valid database name'));
        }

        connectToDatabase(data, 'createDatabase', function (error, db) {
            if (error) {
                return callback(convertMongoErrorToClientError(error));
            } else {
                async.series([
                    function (next) {
                        db.createCollection('default', {}, next);
                    },
                    function (next) {
                        db.dropCollection('default', next);
                    }
                ], function (error) {
                    callback(convertMongoErrorToClientError(error), true);
                    db.close();
                });
            }
        });
    };

    /**
     * Drop database on selected server
     *
     * @roles UsersWithAccess, Admin
     * @description Drop database on selected server
     *
     * @param {object} data The connection-object.
     * @param {!string} data.connectionString The connection string.
     * @param {!string} data.dbName The database name.
     * @param {string=} data.login_database The database to authenticate.
     * @param {!object} request The request object.
     * @param {!function(err, res)} request.getSession Returns the current session object.
     * @param {!function(error, result)} callback The callback.
     */
    pub.dropDatabase = function (data, request, callback) {
        data = data || {};

        connectToDatabase(data, 'dropDatabase', function (error, db) {
            if (error) {
                return callback(convertMongoErrorToClientError(error));
            } else {
                db.dropDatabase(function (err) {
                    if (err) {
                        return callback(new app.ControllerError(err));
                    } else {
                        callback(null, true);
                    }
                    db.close();
                });
            }
        });
    };

    /**
     * Rename database on selected server
     *
     * @roles UsersWithAccess, Admin
     * @description Edit database on selected server
     *
     * @param {object} data The connection-object.
     * @param {!string} data.connectionString The connection string.
     * @param {!object} data.master The master server of the replica set or the current server when no replica set.
     * @param {!string} data.dbName The old database name.
     * @param {!string} data.newDbName The new database name.
     * @param {!object} request The request object.
     * @param {!function(err, res)} request.getSession Returns the current session object.
     * @param {!function(error, result)} callback The callback.
     */
    pub.renameDatabase = function (data, request, callback) {
        data = data || {};

        // check database name
        if (!isValidDatabaseName(data.newDbName)) {
            return callback(new app.ControllerError('Database name "' + data.newDbName + '" is not a valid database name'));
        }

        connectToDatabase(data, 'renameDatabase', function (error, db) {
            if (error) {
                return callback(convertMongoErrorToClientError(error));
            } else {
                copyDatabase(data.master, data.dbName, data.newDbName, function (error) {
                    if (error) {
                        db.close();
                        return callback(convertMongoErrorToClientError(error));
                    } else {
                        // drop old database
                        db.dropDatabase(function (err) {
                            if (err) {
                                callback(new app.ControllerError(err));
                            } else {
                                callback(null, true);
                            }
                            db.close();
                        });
                    }
                });
            }
        });
    };

    /**
     * Copy database on selected server
     *
     * @roles UsersWithAccess, Admin
     * @description Edit database on selected server
     *
     * @param {object} data The connection-object.
     * @param {!object} data.master The master server of the replica set or the current server when no replica set.
     * @param {!string} data.oldDbName The old database name.
     * @param {!string} data.newDbName The new database name.
     * @param {!object} request The request object.
     * @param {!function(err, res)} request.getSession Returns the current session object.
     * @param {!function(error, result)} callback The callback.
     */
    pub.copyDatabase = function (data, request, callback) {
        data = data || {};

        // check database name
        if (!isValidDatabaseName(data.newDbName)) {
            return callback(new app.ControllerError('Database name "' + data.newDbName + '" is not a valid database name'));
        }

        copyDatabase(data.master, data.oldDbName, data.newDbName, function (err, res) {
            if (err) {
                callback(convertMongoErrorToClientError(err));
            } else {
                callback(null, res);
            }
        });
    };

    /**
     * Repair database on selected server
     *
     * @roles UsersWithAccess, Admin
     * @description Repair database on selected server
     *
     * @param {object} data The connection-object.
     * @param {!string} data.connectionString The connection string.
     * @param {!string} data.dbName The old database name.
     * @param {!object} request The request object.
     * @param {!function(err, res)} request.getSession Returns the current session object.
     * @param {!function(error, result)} callback The callback.
     */
    pub.repairDatabase = function (data, request, callback) {
        data = data || {};

        connectToDatabase(data, 'repairDatabase', function (error, db) {
            if (error) {
                return callback(convertMongoErrorToClientError(error));
            } else {
                db.command({repairDatabase: 1}, function (err, res) {
                    if (err) {
                        return callback(new app.ControllerError(err));
                    } else {
                        callback(null, res);
                    }
                    db.close();
                });
            }
        });
    };

    /**
     * Export collection to .json
     *
     * @roles UsersWithAccess, Admin
     * @description Export collection
     *
     * @param {object} data The connection-object.
     * @param {!object} request The request object.
     * @param {!function(err, res)} request.getSession Returns the current session object.
     * @param {!function(error, result)} callback The callback.
     */
    pub.exportCollection = function (data, request, callback) {
        data = data || {};

        // return error because of invalid db name
        if (!isValidDatabaseName(data.dbName)) {
            return callback(new app.ControllerError('Database name "' + data.dbName + '" is not a valid database name'));
        }

        // return error because of missing or invalid collection name
        if (!data.collectionName || !lxHelpers.isString(data.collectionName)) {
            return callback(new app.ControllerError(COLLECTION_NAME_ERROR_MESSAGE));
        }

        var sourceDb,
            pathToTempFolder = path.join(app.config.path.appDataRoot, 'cache'),
            osUptime = JSON.stringify(os.uptime()).replace(/\./, ''),
            fileName = data.dbName + '_' + data.collectionName + '_' + osUptime + '.json',
            currentPath = path.join(pathToTempFolder, fileName),
            socketio = app.socketIo,
            usersocket = (socketio && socketio.sockets && socketio.sockets.sockets && data && data.socketid) ? socketio.sockets.sockets[data.socketid] : undefined;

        // return error because of missing user socket
        if (!usersocket) {
            return callback(new app.ControllerError(COLLECTION_FILESTREAM_ERROR_MESSAGE));
        }

        // send response back to client to prevent timeout
        callback(null, {fileName: fileName});

        var query = data.query || '{}';
        var options = {};
        var documentsCount = 0;

        async.auto({
                getSourceDb: function (next) {
                    connectToDatabase(data, 'exportCollection', next);
                },
                parseQuery: function (next) {
                    // formatting incoming query
                    if (lxHelpers.isString(query) && query !== '{}') {
                        query = formatingData(query);
                    }

                    try {
                        query = JSON.parse(query);
                        next();
                    }
                    catch (err) {
                        next(err);
                    }
                },
                formatQuery: ['parseQuery', function (next) {
                    convertDateTimeAndIdsInDocumentToSave(query, {}, null, function (err, res) {
                        if (err) {
                            return next(new app.ControllerError(err.message));
                        } else {
                            query = convertMongoIdsInQuery(res);
                            next();
                        }
                    });
                }],
                formatOptions: ['parseQuery', function (next) {
                    if (data.options && val.types.object(data.options).valid) {
                        convertDateTimeAndIdsInDocumentToSave(data.options, {}, null, function (err, res) {
                            if (err) {
                                return next(new app.ControllerError(err.message));
                            }

                            options = convertMongoIdsInQuery(res);
                            next();
                        });
                    } else {
                        next();
                    }
                }],
                find: ['getSourceDb', 'formatQuery', 'formatOptions', function (next, results) {
                    sourceDb = results.getSourceDb;
                    var c = sourceDb.collection(data.collectionName).find(query, options || {});
                    next(null, c);
                }],
                getCursorCount: ['find', function (next, results) {
                    results.find.count(next);
                }],
                exportDocuments: ['getCursorCount', function (next, results) {
                    var text = '';

                    if (!fs.existsSync(pathToTempFolder)) {
                        fs.mkdirSync(pathToTempFolder);
                    }

                    var file = fs.createWriteStream(currentPath, 'utf8');
                    var stream = results.find.stream();

                    // Execute find on all the documents
                    stream.on('end', function () {
                        file.end();
                        next();
                    });

                    stream.on('data', function (data) {
                        // add converted and formatted document to string
                        documentsCount++;

                        try {
                            text = prepareDocumentsForExport(data);
                        } catch (e) {
                            app.loggers.syslog.error('json: Cannot convert data to json : %j', data);
                            app.loggers.syslog.error(e);
                            return stream.emit('error', 'Export failed: Cannot convert data with _id ' + JSON.stringify(data._id.$oid) + ' to json : ' + JSON.stringify(e.message));
                        }

                        if (usersocket && documentsCount % 1000 === 0) {
                            usersocket.emit('mms.progress', {
                                max: results.getCursorCount,
                                value: documentsCount,
                                type: 'EXPORT',
                                unit: 'DOCUMENTS_PROGRESS'
                            });
                        }

                        // write data through file stream
                        var textWritten = file.write(text);

                        if (!textWritten) {
                            // pause stream
                            stream.pause();

                            // wait for drain event
                            file.once('drain', function () {
                                // restart stream
                                stream.resume();
                            });
                        }
                    });

                    stream.on('error', function (err) {
                        file.close();
                        app.loggers.syslog.error('export: Error loading data for export : %j', err);
                        app.loggers.syslog.error(err);
                        next(err);
                    });
                }]
            },
            function (error, results) {
                results = null;

                if (error) {
                    if (usersocket) {
                        usersocket.emit('mms.export.error', error);
                    }
                } else {
                    if (usersocket) {
                        usersocket.emit('mms.export.done', {
                            fileName: fileName
                        });
                    }
                }

                if (sourceDb) {
                    sourceDb.close();
                }
            }
        );
    };

    /**
     * Import documents to collection by replace
     *
     * @roles UsersWithAccess, Admin
     * @description Import collection
     *
     * @param {object} data The connection properties.
     * @param {object} file The request or file object.
     * @param callback
     * @returns {*}
     */
    pub.importCollectionReplace = function (data, file, callback) {
        var pathOfDocuments = file && file.content ? file.content.path : '',
            documents,
            sourceDb,
            originCount,
            resultCount,
            usersocket;

        // set user socket for following events
        if (data.selectedOption === 'fileUpload') {
            usersocket = data.socket || undefined;
        } else {
            var socketio = app.socketIo;
            usersocket = (socketio && socketio.sockets && socketio.sockets.sockets && data && data.socketid) ? socketio.sockets.sockets[data.socketid] : undefined;
        }

        // return error because of invalid db name
        if (!isValidDatabaseName(data.dbName)) {
            return callback(new app.ControllerError('Database name "' + data.dbName + '" is not a valid database name'));
        }

        // return error because of missing or invalid collection name
        if (!data.collectionName || !lxHelpers.isString(data.collectionName)) {
            return callback(new app.ControllerError(COLLECTION_NAME_ERROR_MESSAGE));
        }

        // return error because of missing file
        if (!file && data.selectedOption === 'fileUpload') {
            return callback(new app.ControllerError('No files to store or update.'));
        }

        // return error because of missing user socket
        if (!usersocket) {
            return callback(new app.ControllerError(COLLECTION_FILESTREAM_ERROR_MESSAGE));
        }

        // send response back to client to prevent timeout
        callback(null, null);

        async.auto({
                getSourceDb: function (next) {
                    connectToDatabase(data, 'importCollection', function (err, res) {
                        if (res) {
                            sourceDb = res;
                        }
                        next(err, res);
                    });
                },
                readFile: ['getSourceDb', function (next) {
                    if (data.selectedOption === 'fileUpload') {
                        var fileStream = fs.createReadStream(path.join(pathOfDocuments));
                        var streamingData = '';

                        fileStream.on('data', function (chunk) {
                            streamingData += chunk.toString();
                        });

                        fileStream.on('error', function (error) {
                            return next(error);
                        });

                        fileStream.on('close', function () {
                            next(null, streamingData);
                        });
                    } else {
                        next();
                    }
                }],
                unlinkFile: ['readFile', function (next, results) {
                    if (results.readFile && data.selectedOption === 'fileUpload') {
                        fs.unlink(path.join(pathOfDocuments), next);
                    } else {
                        next();
                    }
                }],
                parseDocuments: ['unlinkFile', function (next, results) {
                    if (data.selectedOption === 'fileUpload') {
                        try {
                            documents = JSON.parse(replaceForImport(results.readFile));
                        }
                        catch (e) {
                            return next(e, null);
                        }
                    } else {
                        documents = data.content;
                    }

                    originCount = documents.length;
                    next();
                }],
                dropCollection: ['parseDocuments', function (next, results) {
                    sourceDb = results.getSourceDb;
                    sourceDb.dropCollection(data.collectionName, next);
                }],
                insertDocuments: ['dropCollection', function (next) {
                    var mergedDocumentsArray = splitDocumentsArrayToPackages(documents);
                    var options = {
                        w: 1,
                        keepGoing: (data.isDropDuplicateKeys === true || data.isDropDuplicateKeys === 'true')
                    };

                    async.eachSeries(mergedDocumentsArray, function (documentsPackage, innerCallback) {
                        // insert formatted (ids, date) packages, throw error when instance is slave
                        try {
                            convertDateTimeAndIdsInDocumentToSave(documentsPackage, {}, data.selectedOption, function (err, res) {
                                sourceDb.collection(data.collectionName).insert(res, options,
                                    function (error) {
                                        if (error && ((error.ok && error.ok !== 1) || (error.code === 11000 && !options.keepGoing))) {
                                            innerCallback(error);
                                        } else {
                                            innerCallback();
                                        }
                                    }
                                );
                            });
                        }
                        catch (e) {
                            innerCallback(e);
                        }

                    }, function (error) {
                        if (error && error.ok !== 1) {
                            next(error, null);
                        } else {
                            next(null, true);
                        }
                    });
                }],
                getCountAfterInsert: ['insertDocuments', function (next) {
                    sourceDb.collection(data.collectionName).count(function (error, count) {
                        if (error) {
                            next(error, null);
                        } else {
                            resultCount = count;
                            next();
                        }
                    });
                }]
            },
            function (error) {
                if (error) {
                    if (usersocket) {
                        usersocket.emit('mms.import.error', new app.ControllerError(error.message));
                    }
                } else {
                    if (usersocket) {
                        usersocket.emit('mms.import.done', {
                            originCount: originCount,
                            resultCount: resultCount
                        });
                    }
                }

                if (sourceDb) {
                    sourceDb.close();
                }

            }
        );
    };

    // insert documents of textInput into collection
    function insertDocumentsOfImport (sourceDb, data, callback) {
        var options = {
            w: 1,
            keepGoing: (data.isDropDuplicateKeys === true || data.isDropDuplicateKeys === 'true')
        };

        convertDateTimeAndIdsInDocumentToSave(data.content, {}, data.selectedOption, function (err, res) {
            // insert documents into collection
            sourceDb.collection(data.collectionName).insert(res, options,
                function (error) {
                    if (error && ((error.ok && error.ok !== 1) || (error.code === 11000 && !options.keepGoing))) {
                        callback(error);
                    } else {
                        callback(null, {originCount: data.content.length});
                    }
                }
            );
        });
    }

    // insert documents of fileUpload into collection
    function insertChunksOfStream (sourceDb, data, documentsString, callback) {
        var chunksCount = 0;
        var stringData = '';

        async.auto({
                prepareDocuments: function (next) {
                    // get index of last end of line
                    //var linebreakindex = documentsString.lastIndexOf('}\r\n');
                    var match = documentsString.match(/}\r\n|}\n|}\r/gi);
                    var linebreakindex = documentsString.lastIndexOf(match[match.length - 1]) + 1;

                    // create substring for further use
                    if (linebreakindex >= 0) {
                        // get string with chars after last end of line to send back to read stream
                        stringData = documentsString.substring(linebreakindex + 2);
                        next(null, documentsString.substring(0, linebreakindex));
                    } else {
                        next(null, documentsString);
                    }
                },
                parseDocuments: ['prepareDocuments', function (next, results) {
                    var documents;

                    try {
                        var stringReadyToParse = replaceForImport(results.prepareDocuments);
                        documents = JSON.parse(stringReadyToParse);
                    }
                    catch (e) {
                        return next(e, null);
                    }

                    chunksCount = documents.length;
                    next(null, documents);
                }],
                insertDocuments: ['parseDocuments', function (next, results) {
                    data.content = results.parseDocuments;
                    insertDocumentsOfImport(sourceDb, data, next);
                }]
            },
            function (error) {
                if (error) {
                    callback(convertMongoErrorToClientError(error));
                } else {
                    callback(null, {documentsCount: chunksCount, stringData: stringData});
                }
            }
        );
    }

    // read content of fileUpload
    function readStream (fd, size, options, cb) {
        options.buffer = options.buffer || new Buffer(size);
        options.buffer.fill('\x00');
        options.count = options.count || 0;
        options.position = options.position || 0;
        var usersocket = options.data.socket || undefined;

        fs.read(fd, options.buffer, 0, size, null, function (err, bytesreaded) {
            if (err) {
                return cb(err);
            }

            // close stream if no content more to read
            if (bytesreaded === 0) {
                fs.close(fd, function (errorClose) {
                    cb(errorClose, {originCount: options.count});
                });
            } else {
                // build string of elements from last loop and new data
                var insertString = (options.stringData || '') + options.buffer.toString('utf8');

                // parse chunk of stream and insert it into collection
                insertChunksOfStream(options.sourceDb, options.data, insertString, function (err, res) {
                    if (err || !res) {
                        fs.close(fd, function (errorClose) {
                            return cb(err || errorClose || 'Cannot insert file content.');
                        });
                    } else {
                        options.position += bytesreaded || 0;
                        options.stringData = res.stringData || '';
                        options.count += res.documentsCount || 0;

                        if (usersocket) {
                            usersocket.emit('mms.progress', {
                                max: options.fileSize,
                                value: options.position,
                                type: 'IMPORT',
                                unit: 'MB'
                            });
                        }

                        // recursion to get next chunk
                        readStream(fd, size, options, cb);
                    }

                });
            }
        });
    }

    /**
     * Import documents to collection by append
     *
     * @roles UsersWithAccess, Admin
     * @description Import collection
     *
     * @param {object} data The connection properties.
     * @param {object} file The request or file object.
     * @param callback
     * @returns {*}
     */
    pub.importCollectionAppend = function (data, file, callback) {
        var pathOfDocuments = file && file.content ? file.content.path : '',
            fileSize = file && file.content ? file.content.size : '',
            sourceDb,
            resultCount,
            usersocket;

        // set user socket for following events
        if (data.selectedOption === 'fileUpload') {
            usersocket = data.socket || undefined;
        } else {
            var socketio = app.socketIo;
            usersocket = (socketio && socketio.sockets && socketio.sockets.sockets && data && data.socketid) ? socketio.sockets.sockets[data.socketid] : undefined;
        }

        // return error because of invalid db name
        if (!isValidDatabaseName(data.dbName)) {
            return callback(new app.ControllerError('Database name "' + data.dbName + '" is not a valid database name'));
        }

        // return error because of missing or invalid collection name
        if (!data.collectionName || !lxHelpers.isString(data.collectionName)) {
            return callback(new app.ControllerError(COLLECTION_NAME_ERROR_MESSAGE));
        }

        // return error because of missing file
        if (!file && data.selectedOption === 'fileUpload') {
            return callback(new app.ControllerError('No files to store or update.'));
        }

        // return error because of missing user socket
        if (!usersocket) {
            return callback(new app.ControllerError(COLLECTION_FILESTREAM_ERROR_MESSAGE));
        }

        // send response back to client to prevent timeout
        callback(null, null);

        async.auto({
                getSourceDb: function (next) {
                    connectToDatabase(data, 'importCollection', function (err, res) {
                        if (res) {
                            sourceDb = res;
                        }
                        next(err, res);
                    });
                },
                getCountBeforeInsert: ['getSourceDb', function (next) {
                    sourceDb.collection(data.collectionName).count(function (error, count) {
                        if (error) {
                            next(error, null);
                        } else {
                            resultCount = count;
                            next();
                        }
                    });
                }],
                processData: ['getCountBeforeInsert', function (next) {
                    if (data.selectedOption === 'fileUpload') {
                        // set options for file upload
                        var options = {
                            sourceDb: sourceDb,
                            data: data,
                            fileSize: fileSize
                        };

                        var fileStream = fs.openSync(path.join(pathOfDocuments), 'r');

                        return readStream(fileStream, 1024 * 1024 * 10, options, next);
                        //return readStream(fileStream, 1024*10, options, next);
                    } else {
                        // insert documents from text import
                        insertDocumentsOfImport(sourceDb, data, next);
                    }
                }],
                unlinkFile: ['processData', function (next, results) {
                    if (results.readFile && data.selectedOption === 'fileUpload') {
                        fs.unlink(path.join(pathOfDocuments), next);
                    } else {
                        next();
                    }
                }],
                getCountAfterInsert: ['unlinkFile', function (next) {
                    sourceDb.collection(data.collectionName).count(function (error, count) {
                        if (error) {
                            next(error, null);
                        } else {
                            resultCount = count - resultCount;
                            next();
                        }
                    });
                }]
            },
            function (error, results) {
                if (error) {
                    if (usersocket) {
                        usersocket.emit('mms.import.error', new app.ControllerError(error.message));
                    }
                } else {
                    if (usersocket) {
                        usersocket.emit('mms.import.done', {
                            originCount: results.processData.originCount,
                            resultCount: resultCount
                        });
                    }
                }

                if (sourceDb) {
                    sourceDb.close();
                }
            }
        );
    };

    /**
     * Create a new collection on selected database
     *
     * @roles UsersWithAccess, Admin
     * @description Create a new collection on selected database
     *
     * @param {object} data The connection-object.
     * @param {!string} data.connectionString The string including server, port.
     * @param {!string} data.dbName The name of the database.
     * @param {!object} data.newCollection The new collection.
     * @param {!object} request The request object.
     * @param {!function(err, res)} request.getSession Returns the current session object.
     * @param {!function(error, result)} callback The callback.
     */
    pub.createCollection = function (data, request, callback) {
        data = data || {};
        var sourceDb,
            options;

        async.auto({
                getSourceDb: function (next) {
                    connectToDatabase(data, 'createCollection', next);
                },
                validateNewCollection: ['getSourceDb', function (next) {
                    var schema = {
                        properties: {
                            name: {
                                type: 'string',
                                required: true,
                                minLength: 1,
                                maxLength: 128,
                                conform: function (value) {
                                    return isValidCollectionName(value);
                                },
                                messages: {
                                    conform: 'is not a valid collection name'
                                }
                            },
                            isGridFSCollection: {
                                type: 'boolean'
                            },
                            autoIndexId: {
                                type: 'boolean'
                            },
                            capped: {
                                type: 'boolean'
                            },
                            size: {
                                type: 'integer',
                                minimum: 0,
                                conform: function (value, data) {
                                    if (data.capped) {
                                        return value >= 0;
                                    }

                                    return true;
                                },
                                messages: {
                                    conform: 'size is required and must be greater then -1 when capped is true'
                                }
                            },
                            max: {
                                type: 'integer',
                                minimum: 0
                            },
                            usePowerOf2Sizes: {
                                type: 'boolean'
                            }
                        }
                    };

                    var validation = val.validate(data.newCollection || {}, schema);
                    if (validation.valid) {
                        next(null, validation);
                    } else {
                        next(new app.ValidationError(validation.errors));
                    }
                }],
                createCollection: ['validateNewCollection', function (next, results) {
                    sourceDb = results.getSourceDb;
                    options = {
                        autoIndexId: data.newCollection.autoIndexId,
                        size: data.newCollection.size,
                        capped: !!data.newCollection.capped,
                        max: data.newCollection.max,
                        usePowerOf2Sizes: data.usePowerOf2Sizes,
                        strict: true
                    };

                    if (data.newCollection.isGridFSCollection || isGridFSCollection(data.newCollection.name)) {
                        data.newCollection.name = getNameOfFilesCollection(data.newCollection.name);
                    }

                    sourceDb.createCollection(data.newCollection.name, options, next);
                }],
                createChunks: ['createCollection', function (next, results) {
                    if ((data.newCollection.isGridFSCollection || isGridFSCollection(data.newCollection.name)) && results.createCollection) {
                        sourceDb.createCollection(getNameOfChunksCollection(data.newCollection.name), options, next);
                    } else {
                        next();
                    }
                }]
            },
            function (error) {
                if (error) {
                    callback(convertMongoErrorToClientError(error));
                } else {
                    callback(null, true);
                }

                if (sourceDb) {
                    sourceDb.close();
                }
            }
        );
    };

    /**
     * Drop collection from database.
     *
     * @roles UsersWithAccess, Admin
     * @description Drop collection from database
     *
     * @param {object} data The connection-object.
     * @param {!string} data.connectionString The connection string.
     * @param {!string} data.dbName The database name.
     * @param {!string} data.collectionName The collection name.
     * @param {!object} request The request object.
     * @param {!function(err, res)} request.getSession Returns the current session object.
     * @param {!function(error, result)} callback The callback.
     */
    pub.dropCollection = function (data, request, callback) {
        data = data || {};
        var sourceDb;

        if (!data.collectionName || !lxHelpers.isString(data.collectionName)) {
            return callback(new app.ControllerError(COLLECTION_NAME_ERROR_MESSAGE));
        }

        async.auto({
                getSourceDb: function (next) {
                    connectToDatabase(data, 'dropCollection', next);
                },
                dropCollection: ['getSourceDb', function (next, results) {
                    sourceDb = results.getSourceDb;
                    sourceDb.dropCollection(data.collectionName, next);
                }],
                dropChunks: ['dropCollection', function (next, results) {
                    if (isGridFSCollection(data.collectionName) && data.collectionName.length !== 6 && results.dropCollection) {
                        sourceDb.dropCollection(getNameOfChunksCollection(data.collectionName), next);
                    } else {
                        next();
                    }
                }]
            },
            function (error) {
                if (error) {
                    callback(convertMongoErrorToClientError(error));
                } else {
                    callback(null, true);
                }

                if (sourceDb) {
                    sourceDb.close();
                }
            }
        );
    };

    /**
     * Rename chosen collection of a database.
     *
     * @roles UsersWithAccess, Admin
     * @description Rename chosen collection of a database
     *
     * @param {object} data The connection-object.
     * @param {!string} data.connectionString The connection string.
     * @param {!string} data.dbName The database name.
     * @param {!string} data.oldCollectionName The current collection name.
     * @param {!string} data.collectionName The new collection name.
     * @param {!object} request The request object.
     * @param {!function(err, res)} request.getSession Returns the current session object.
     * @param {!function(error, result)} callback The callback.
     */
    pub.renameCollection = function (data, request, callback) {
        data = data || {};
        var db;

        if (!data.oldCollectionName || !lxHelpers.isString(data.oldCollectionName)) {
            return callback(new app.ControllerError('Old collection name: ' + COLLECTION_NAME_ERROR_MESSAGE));
        }

        if (!data.collectionName || !lxHelpers.isString(data.collectionName)) {
            return callback(new app.ControllerError('New collection name: ' + COLLECTION_NAME_ERROR_MESSAGE));
        }

        if (!isValidCollectionName(data.collectionName)) {
            return callback(new app.ControllerError('New collection name is not a valid collection name'));
        }

        if (!isValidCollectionName(data.oldCollectionName)) {
            return callback(new app.ControllerError('Old collection name is not a valid collection name'));
        }

        if (isGridFSCollection(data.oldCollectionName)) {
            data.collectionName = getNameOfFilesCollection(data.collectionName);
        }

        function clientCallback (error, result) {
            if (error) {
                callback(new app.ControllerError(error.message));
            } else {
                callback(null, !!result);
            }

            if (db) {
                db.close();
            }
        }

        connectToDatabase(data, 'renameCollection', function (error, openDb) {
            if (error) {
                return callback(convertMongoErrorToClientError(error));
            } else {
                db = openDb;
                db.renameCollection(data.oldCollectionName, data.collectionName, function (error, result) {
                    if (error) {
                        clientCallback(convertMongoErrorToClientError(error));
                    } else {
                        if (isGridFSCollection(data.oldCollectionName)) {
                            db.renameCollection(getNameOfChunksCollection(data.oldCollectionName), getNameOfChunksCollection(data.collectionName), clientCallback);
                        } else {
                            clientCallback(null, result);
                        }
                    }
                });
            }
        });
    };

    /**
     * Copy chosen collection.
     *
     * @roles UsersWithAccess, Admin
     * @description Copy chosen collection
     *
     * @param {object} data The connection-object.
     * @param {!string} data.connectionString The connection string.
     * @param {!string} data.destinationConnectionString The destination connectionString string.
     * @param {!string} data.dbName The database name.
     * @param {!string} data.destinationDbName The destination database name.
     * @param {!string} data.collectionName The collection name.
     * @param {!string} data.destinationCollectionName The destination collection name.
     * @param {!object} request The request object.
     * @param {!function(err, res)} request.getSession Returns the current session object.
     * @param {!function(error, result)} callback The callback.
     */
    pub.copyCollection = function (data, request, callback) {
        data = data || {};
        var sourceDb, destinationDb;

        if (!data.destinationCollectionName || !lxHelpers.isString(data.destinationCollectionName)) {
            return callback(new app.ControllerError('Destination collection name: ' + COLLECTION_NAME_ERROR_MESSAGE));
        }

        if (!data.collectionName || !lxHelpers.isString(data.collectionName)) {
            return callback(new app.ControllerError('Source collection name: ' + COLLECTION_NAME_ERROR_MESSAGE));
        }

        if (!isValidCollectionName(data.destinationCollectionName)) {
            return callback(new app.ControllerError('Destination collection name is not a valid collection name'));
        }

        if (!isValidCollectionName(data.collectionName)) {
            return callback(new app.ControllerError('Source collection name is not a valid collection name'));
        }

        if (isGridFSCollection(data.collectionName)) {
            data.destinationCollectionName = getNameOfFilesCollection(data.destinationCollectionName);
            data.destinationCollectionNameChunks = getNameOfChunksCollection(data.destinationCollectionName);
        }

        async.auto({
                getDestinationDb: function (next) {
                    connectToDatabase({
                        connectionString: data.destinationConnectionString,
                        dbName: data.destinationDbName,
                        login_database: data.destination_login_database,
                        login: data.destination_login,
                        password: data.destination_password
                    }, 'copyCollection', next);
                },
                isCollectionNameUnique: ['getDestinationDb', function (next, results) {
                    destinationDb = results.getDestinationDb;
                    destinationDb.collectionNames(function (error, result) {
                        if (error) {
                            return next(error);
                        }

                        //var collectionFullName = data.destinationDbName + '.' + data.destinationCollectionName;
                        var collectionFullName = data.destinationCollectionName;
                        var collectionFullNameChunks = data.destinationDbName + '.' + data.destinationCollectionNameChunks;
                        var existingCollection = lxHelpers.arrayFirst(result, function (item) {
                            return item.name === collectionFullName || item.name === collectionFullNameChunks;
                        });

                        next(existingCollection ? new app.ControllerError('Collection already exists in destination database') : null);
                    });
                }],
                getSourceDb: ['isCollectionNameUnique', function (next) {
                    connectToDatabase(data, 'copyCollection', next);
                }],
                createCollection: ['getSourceDb', function (next, results) {
                    if (data.selectedOption === 'differentServer' && data.dbName === data.destinationDbName) {
                        next();
                    } else {
                        sourceDb = results.getSourceDb;

                        // get stats from source collection to create new collection (except cloneCollection between different servers)
                        sourceDb.collection(data.collectionName).options(function (err, res) {
                            if (res) {
                                var dataToCreate = {
                                    connectionString: data.destinationConnectionString,
                                    dbName: data.destinationDbName,
                                    newCollection: {
                                        name: data.destinationCollectionName,
                                        autoIndexId: res.autoIndexId,
                                        size: res.size,
                                        capped: res.capped,
                                        max: res.max
                                    },
                                    login_database: data.destination_login_database,
                                    login: data.destination_login,
                                    password: data.destination_password
                                };

                                pub.createCollection(dataToCreate, {}, next);
                            } else {
                                next();
                            }
                        });
                    }
                }],
                copyDocumentsWithScript: ['createCollection', function (next, results) {
                    sourceDb = results.getSourceDb;
                    destinationDb = results.getDestinationDb;

                    if (data.selectedOption === 'sameDbSameServer') {
                        // execute script, if new collection in same db on same server
                        sourceDb.command(
                            {
                                eval: 'function( collName , newName ){ var from = db.getCollection(collName); var to = db.getCollection(newName); to.ensureIndex( { _id : 1 } ); var count = 0; var cursor = from.find(); while ( cursor.hasNext() ){ var o = cursor.next(); count++; to.save( o ); } return count; }',
                                args: [data.collectionName, data.destinationCollectionName]
                            }, function (err, res) {
                                next(null, err ? {errmsg: err.message} : res);
                            });
                    }
                    //else if (data.selectedOption === 'differentServer' && data.dbName === data.destinationDbName) {
                    //    // execute script, if new collection on same db on different server
                    //    var collection = data.dbName + '.' + data.collectionName;
                    //
                    //    destinationDb.command(
                    //        {
                    //            cloneCollection: collection,
                    //            from: data.master
                    //
                    //        }, next);
                    //}
                    else if (data.selectedOption === 'differentDatabase') {
                        // execute script, if new collection on different db on same server
                        sourceDb.command(
                            {
                                eval: 'function( collName, newDb ){ var from = db.getCollection(collName); var to = db.getSiblingDB(newDb)[collName]; to.ensureIndex( { _id : 1 } ); var count = 0; var cursor = from.find(); while ( cursor.hasNext() ){ var o = cursor.next(); count++; to.save( o ); } return count; }',
                                args: [data.collectionName, data.destinationDbName]
                            }, function (err, res) {
                                next(null, err ? {errmsg: err.message} : res);
                            });
                    }
                    else {
                        next();
                    }
                }],
                getDocuments: ['copyDocumentsWithScript', function (next, results) {
                    // fallback and copy-option for new collection on different server and different db
                    //if ((data.selectedOption === 'differentServer' && data.dbName !== data.destinationDbName) || (results.copyDocumentsWithScript && results.copyDocumentsWithScript.errmsg)) {
                    //    sourceDb = results.getSourceDb;
                    //
                    //    sourceDb.collection(data.collectionName).find().toArray(next);
                    //} else {
                    //    next();
                    //}

                    // fallback and copy-option for new collection on different server
                    if (data.selectedOption === 'differentServer' || (results.copyDocumentsWithScript && results.copyDocumentsWithScript.errmsg)) {
                        sourceDb = results.getSourceDb;

                        sourceDb.collection(data.collectionName).find(next);
                    } else {
                        next();
                    }
                }],
                insertDocuments: ['getDocuments', function (next, results) {
                    if (results.getDocuments) {
                        destinationDb = results.getDestinationDb;
                        var cursor = results.getDocuments;

                        // loop through documents
                        var processItem = function (err, item) {
                            if (err) {
                                return next(err);
                            }

                            // end of cursor
                            if (!item) {
                                return next(null, true);
                            }

                            destinationDb.collection(data.destinationCollectionName).insert(item, function (err) {
                                if (err) {
                                    app.loggers.syslog.error('copy: Error copy collection');
                                    app.loggers.syslog.error(err);

                                    cursor.close();
                                    return next(err);
                                }

                                cursor.nextObject(processItem);
                            });
                        };

                        cursor.nextObject(processItem);
                    } else {
                        next();
                    }
                }],
                checkIfGridFS: ['insertDocuments', function (next, results) {
                    if (isGridFSCollection(data.collectionName) && (results.insertDocuments || (results.copyDocumentsWithScript && !results.copyDocumentsWithScript.errmsg))) {
                        sourceDb = results.getSourceDb;
                        // get documents of chunks collection
                        sourceDb.collection(getNameOfChunksCollection(data.collectionName)).find(next);
                    } else {
                        next();
                    }
                }],
                insertChunks: ['checkIfGridFS', function (next, results) {
                    if (results.checkIfGridFS) {
                        destinationDb = results.getDestinationDb;
                        var cursor = results.checkIfGridFS;

                        // loop through documents
                        var processItem = function (err, item) {
                            if (err) {
                                return next(err);
                            }

                            // end of cursor
                            if (!item) {
                                return next(null, true);
                            }

                            destinationDb.collection(data.destinationCollectionNameChunks).insert(item, function (err) {
                                if (err) {
                                    app.loggers.syslog.error('copy: Error copy collection');
                                    app.loggers.syslog.error(err);

                                    cursor.close();
                                    return next(err);
                                }

                                cursor.nextObject(processItem);
                            });
                        };

                        cursor.nextObject(processItem);
                    } else {
                        next();
                    }
                }]
            },
            function (error) {
                if (error) {
                    callback(new app.ControllerError('Mongo Error: ' + (error.message || 'Unknow Mongo Error')));
                } else {
                    callback(null, true);
                }

                if (destinationDb) {
                    destinationDb.close();
                }

                if (sourceDb) {
                    sourceDb.close();
                }
            }
        );
    };

    /**
     * Gets all Collections of selected Db
     *
     * @roles UsersWithAccess, Admin
     * @description Gets all collections from Db
     *
     * @param {object} data The connection-object.
     * @param {!string} data.connectionString The connection string.
     * @param {!string} data.dbName The database name.
     * @param {!object} request The request object.
     * @param {!function(err, res)} request.getSession Returns the current session object.
     * @param {!function(error, result)} callback The callback.
     */
    pub.getAllCollectionsNamesFromDatabase = function (data, request, callback) {
        connectToDatabase(data, 'getAllCollectionsNamesFromDatabase', function (error, db) {
            if (error) {
                return callback(new app.ControllerError(error.message));
            }

            db.collectionNames(function (error, result) {
                if (error) {
                    callback(new app.ControllerError(error.message));
                } else {
                    var collectionNames = lxHelpers.arrayMap(result || [], function (collection) {
                        return collection.name;
                    });

                    callback(null, collectionNames.sort());
                }

                db.close();
            });
        });
    };

    /**
     * Set a query to selected collection
     *
     * @roles UsersWithAccess, Admin
     * @description Gets all query-relevant documents from collection
     *
     * @param {object} data The connection-object.
     * @param {!string} data.connectionString The connection string.
     * @param {!string} data.dbName The database name.
     * @param {!string} data.collectionName The collection name.
     * @param {object=} data.query The mongodb query.
     * @param {object=} data.options The mongodb options.
     * @param {!object} request The request object.
     * @param {!function(err, res)} request.getSession Returns the current session object.
     * @param {!function(error, result)} callback The callback.
     */
    pub.getAll = function (data, request, callback) {
        data = data || {};

        if (!data.collectionName || !lxHelpers.isString(data.collectionName)) {
            return callback(new app.ControllerError(COLLECTION_NAME_ERROR_MESSAGE));
        }

        var query = data.query || '{}';

        // formatting incoming query
        if (lxHelpers.isString(query) && query !== '{}') {
            query = formatingData(query);
        }

        try {
            query = JSON.parse(query);
            //query = convertDateTimeAndIdsInDocumentToSave(query, {});
        }
        catch (err) {
            return callback(new app.ControllerError(err.message));
        }

        connectToDatabase(data, 'getAll', function (error, db) {
            if (error) {
                return callback(convertMongoErrorToClientError(error));
            }

            if (query) {
                var options = {};
                //var options = data.options && val.types.object(data.options).valid ? convertMongoIdsInQuery(convertDateTimeAndIdsInDocumentToSave(data.options, {})) : {};
                var collection = db.collection(data.collectionName);

                async.auto({
                        formatQuery: function (next) {
                            convertDateTimeAndIdsInDocumentToSave(query, {}, null, function (err, res) {
                                if (err) {
                                    return next(new app.ControllerError(err.message));
                                } else {
                                    query = convertMongoIdsInQuery(res);
                                    next();
                                }
                            });
                        },
                        formatOptions: function (next) {
                            if (data.options && val.types.object(data.options).valid) {
                                convertDateTimeAndIdsInDocumentToSave(data.options, {}, null, function (err, res) {
                                    if (err) {
                                        return next(new app.ControllerError(err.message));
                                    }

                                    options = convertMongoIdsInQuery(res);
                                    next();
                                });
                            } else {
                                next();
                            }
                        },
                        find: ['formatQuery', 'formatOptions', function (next) {
                            if (lxHelpers.isObject(query)) {
                                collection.find(query, options).toArray(next);
                            } else {
                                next({message: 'query selector must be an object'});
                            }
                        }],
                        count: ['formatQuery', 'formatOptions', function (next) {
                            collection.count(query, next);
                        }],
                        populateMetadata: ['find', function (next, results) {
                            var metadataObj = {};

                            if (!results.find || results.find.length === 0) {
                                return next(null, metadataObj);
                            }

                            lxHelpers.forEach(results.find, function (item) {
                                metadataObj[item._id] = populateMetadata(item);
                            });

                            next(null, metadataObj);
                        }],
                        convertValuesOfDocuments: ['populateMetadata', function (next, results) {
                            if (!results.find || results.find.length === 0) {
                                return next();
                            }

                            results.find = lxHelpers.arrayMap(results.find, function (document) {
                                return convertValuesOfDocumentsForClient(document);
                            });
                            next();
                        }]
                    },
                    function (error, results) {
                        if (error) {
                            return callback(new app.ControllerError(error.message), null);
                        } else {
                            callback(null, {
                                items: results.find,
                                count: results.count,
                                metadata: results.populateMetadata,
                                schema: results.getSchema
                            });
                        }

                        db.close();
                    }
                );
            }
        });
    };

    /**
     * Save a new or edited document
     *
     * @roles UsersWithAccess, Admin
     * @description Save a new or edited document
     *
     * @param {object} data The connection-object.
     * @param {!string} data.connectionString The connection string.
     * @param {!string} data.dbName The database name.
     * @param {!string} data.collectionName The collection name.
     * @param {!object} request The request object.
     * @param {!function(err, res)} request.getSession Returns the current session object.
     * @param {!function(error, result)} callback The callback.
     */
    pub.saveDocument = function (data, request, callback) {
        data = data || {};

        if (!data.collectionName || !lxHelpers.isString(data.collectionName)) {
            return callback(new app.ControllerError(COLLECTION_NAME_ERROR_MESSAGE));
        }

        convertDateTimeAndIdsInDocumentToSave(data.data, data.metadata || {}, null, function (err, res) {
            if (err) {
                return callback(err);
            } else {
                data.data = res;
                saveDocumentInCollection(data, callback);
            }
        });
    };

    /**
     * Get indexes of a collection
     *
     * @roles UsersWithAccess, Admin
     * @description Get indexes of a collection
     *
     * @param {object} data The collection-relevant data.
     * @param {!string} data.connectionString The string including server, port.
     * @param {!string} data.dbName The name of the database.
     * @param {!string} data.collectionName The name of collection.
     * @param {!object} request The request object.
     * @param callback
     */
    pub.getCollectionIndexes = function (data, request, callback) {
        data = data || {};

        if (!data.collectionName || !lxHelpers.isString(data.collectionName)) {
            return callback(new app.ControllerError(COLLECTION_NAME_ERROR_MESSAGE));
        }

        connectToDatabase(data, 'getCollectionIndexes', function (error, db) {
            if (error) {
                return callback(convertMongoErrorToClientError(error));
            }

            db.collection(data.collectionName).indexInformation({full: true}, function (error, result) {
                if (error) {
                    return callback(new app.ControllerError(error.message), null);
                } else {
                    callback(null, result);
                }

                db.close();
            });
        });
    };

    /**
     * Drop all indexes of a collection
     *
     * @roles UsersWithAccess, Admin
     * @description Drop all indexes of a collection
     *
     * @param {object} data The index-relevant data.
     * @param {!string} data.connectionString The string including server, port.
     * @param {!string} data.dbName The name of the database.
     * @param {!string} data.collectionName The name of collection.
     * @param {string=} data.login_database The database to authenticate.
     * @param {!object} request The request object.
     * @param callback
     */
    pub.dropAllIndexesOfCollection = function (data, request, callback) {
        data = data || {};

        if (!data.collectionName || !lxHelpers.isString(data.collectionName)) {
            return callback(new app.ControllerError(COLLECTION_NAME_ERROR_MESSAGE));
        }

        connectToDatabase(data, 'dropAllIndexesOfCollection', function (error, db) {
            if (error) {
                return callback(convertMongoErrorToClientError(error));
            }

            db.collection(data.collectionName).dropAllIndexes(function (error, result) {
                if (error) {
                    return callback(new app.ControllerError(error.message), null);
                } else {
                    callback(null, result);
                }

                db.close();
            });
        });
    };

    /**
     * Drop selected index of a collection
     *
     * @roles UsersWithAccess, Admin
     * @description Drop selected index of a collection
     *
     * @param {object} data The index-relevant data.
     * @param {!string} data.connectionString The string including server, port.
     * @param {!string} data.collectionName The name of collection.
     * @param {!string} data.dbName The name of the database.
     * @param {!object} request The request object.
     * @param callback
     */
    pub.dropIndex = function (data, request, callback) {
        data = data || {};

        if (!data.collectionName || !lxHelpers.isString(data.collectionName)) {
            return callback(new app.ControllerError(COLLECTION_NAME_ERROR_MESSAGE));
        }

        connectToDatabase(data, 'dropIndex', function (error, db) {
            if (error) {
                return callback(convertMongoErrorToClientError(error));
            }

            db.collection(data.collectionName).dropIndex(data.nameOfIndex, function (error, result) {
                if (error) {
                    return callback(new app.ControllerError(error.message), null);
                } else {
                    callback(null, result);
                }

                db.close();
            });
        });
    };

    /**
     * Set index of a collection
     *
     * @roles UsersWithAccess, Admin
     * @description Set index of a collection
     *
     * @param {object} data The index-relevant data.
     * @param {!string} data.connectionString The string including server, port.
     * @param {!string} data.collectionName The name of collection.
     * @param {!string} data.dbName The name of the database.
     * @param {!object} request The request object.
     * @param callback
     */
    pub.setIndexToCollection = function (data, request, callback) {
        data = data || {};
        var dbSetIndex;

        if (!data.collectionName || !lxHelpers.isString(data.collectionName)) {
            return callback(new app.ControllerError(COLLECTION_NAME_ERROR_MESSAGE));
        }

        async.auto({
                getSourceDb: function (next) {
                    connectToDatabase(data, 'setIndexToCollection', next);
                },
                getListOfIndexes: ['getSourceDb', function (next, results) {
                    dbSetIndex = results.getSourceDb;
                    if (dbSetIndex.serverConfig && dbSetIndex.serverConfig.isMasterDoc && !dbSetIndex.serverConfig.isMasterDoc.ismaster) {
                        next({message: 'not master'});
                    } else {
                        dbSetIndex.collection(data.collectionName).indexInformation({full: true}, next);
                    }
                }],
                validateSchema: ['getListOfIndexes', function (next, results) {
                    var originName = data.nameOfIndex || '';

                    var schema = {
                        properties: {
                            key: {
                                type: 'object',
                                required: true,
                                conform: function (value) {
                                    return nameNotExistsInIndexArray(results.getListOfIndexes, value, 'key', originName);
                                },
                                messages: {
                                    conform: 'index-key already exists or is empty'
                                },
                                properties: getPropertiesOfIndexObjectFields(data.index.key)
                            },
                            options: {
                                type: 'object',
                                properties: {
                                    name: {
                                        type: 'string',
                                        maxLength: 125,
                                        conform: function (value) {
                                            return nameNotExistsInIndexArray(results.getListOfIndexes, value, 'name', originName);
                                        },
                                        messages: {
                                            conform: 'index-name already exists'
                                        }
                                    },
                                    unique: {
                                        type: 'boolean'
                                    },
                                    dropDups: {
                                        type: 'boolean',
                                        conform: function (actual, indexData) {
                                            if (indexData.unique) {
                                                return true;
                                            } else {
                                                return !(!indexData.unique && actual === true);
                                            }
                                        },
                                        messages: {
                                            conform: 'drop duplicates must set in right relation to unique-field'
                                        }
                                    },
                                    sparse: {
                                        type: 'boolean'
                                    },
                                    expireAfterSeconds: {
                                        type: 'integer',
                                        minimum: 0
                                    },
                                    background: {
                                        type: 'boolean'
                                    },
                                    default_language: {
                                        type: 'string'
                                    },
                                    language_override: {
                                        type: 'string'
                                    },
                                    weights: {
                                        type: 'object',
                                        properties: getPropertiesOfIndexObjectFields(data.index.options.weights)
                                    }
                                }
                            }
                        }
                    };

                    var validation = val.validate(data.index || {}, schema);
                    if (validation.valid) {
                        next(null, true);
                    } else {
                        next(new app.ValidationError(validation.errors));
                    }
                }],
                dropIndexIfExists: ['validateSchema', function (next) {
                    if (data.index.isNew) {
                        next(null, true);
                    } else {
                        dbSetIndex.collection(data.collectionName).dropIndex(data.nameOfIndex, next);
                    }
                }],
                ensureIndex: ['dropIndexIfExists', function (next) {
                    dbSetIndex.collection(data.collectionName).ensureIndex(data.index.key, data.index.options, function (err, res) {
                        if (res) {
                            next(null, res);
                        } else if (err && data.index.isNew) {
                            // skip restoring old index, if index is new and throw error
                            next(err, null);
                        } else {
                            // jump into restoring of old index, if error while updating the index
                            next();
                        }
                    });
                }],
                fallbackForEnsureFailure: ['ensureIndex', function (next, results) {
                    if (results.ensureIndex) {
                        next();
                    } else {
                        var indexToRestore = {};

                        // get old index from list of indexes
                        for (var i = 0; i < results.getListOfIndexes.length; i++) {
                            if (results.getListOfIndexes[i].name === data.nameOfIndex) {
                                indexToRestore = results.getListOfIndexes[i];
                                break;
                            }
                        }
                        // restore old index
                        dbSetIndex.collection(data.collectionName).ensureIndex(indexToRestore.key, indexToRestore, next);
                    }
                }],
                getNewListOfIndexes: ['fallbackForEnsureFailure', function (next) {
                    dbSetIndex.collection(data.collectionName).indexInformation({full: true}, next);
                }]
            },
            function (error, results) {
                if (error) {
                    callback(convertMongoErrorToClientError(error));
                } else {
                    callback(null, {indexName: results.ensureIndex, indexList: results.getNewListOfIndexes});
                }

                if (dbSetIndex) {
                    dbSetIndex.close();
                }
            }
        );
    };

    /**
     * Delete a selected document
     *
     * @roles UsersWithAccess, Admin
     * @description Delete a selected document
     *
     * @param {object} data The connection-object.
     * @param {!string} data.connectionString The connection string.
     * @param {!string} data.dbName The database name.
     * @param {!string} data.collectionName The collection name.
     * @param {!Array} data.documentsIds The mongo ObjectIDs of the documents to delete.
     * @param {!object} request The request object.
     * @param {!function(err, res)} request.getSession Returns the current session object.
     * @param {!function(error, result)} callback The callback.
     */
    pub.deleteDocument = function (data, request, callback) {
        data = data || {};
        var db,
            gridstore,
            countOfDeletedDocuments = 0;

        if (!data.collectionName || !lxHelpers.isString(data.collectionName)) {
            return callback(new app.ControllerError(COLLECTION_NAME_ERROR_MESSAGE));
        }

        function clientCallback (error, result) {
            if (error) {
                callback(new app.ControllerError(error.message));
            } else {
                callback(null, result);
            }

            if (db) {
                db.close();
            }
        }

        connectToDatabase(data, 'deleteDocument', function (error, connectDb) {
            if (error) {
                return callback(convertMongoErrorToClientError(error));
            } else {
                db = connectDb;

                async.each(data.documentsIds, function (idToDelete, next) {
                    var id;
                    if (idToDelete) {
                        id = val.formats.mongoId(idToDelete.id).valid && idToDelete.metadata === 'ObjectID' ? getMongoId(idToDelete.id) : idToDelete.id;
                    } else {
                        id = null;
                    }

//                    // callback error if only one document to delete
//                    if (!id && data.documentsIds.length === 1) {
//                        return callback(new app.ControllerError('id is not a valid mongo-id'));
//                    }

                    // Detect if GridFS collection
                    if (data.collectionName.indexOf('.files', data.collectionName.length - 6) !== -1) {
                        // cut the .files from collection name
                        var options = {
                            root: data.collectionName.split('.')[0] || 'fs',
                            w: 1,
                            fsync: true
                        };

                        gridstore = new GridStore(db, id, 'r', options);
                        gridstore.open(function (error, gridStore) {
                            if (error || !gridStore) {
                                next(error, null);
                            } else {
                                // Unlink the file
                                gridStore.unlink(function (error) {
                                    if (error) {
                                        next(error, null);
                                    } else {
                                        countOfDeletedDocuments++;
                                        next(null, true);
                                    }
                                });
                                gridstore.close();
                            }
                        });
                    } else {
                        db.collection(data.collectionName).remove({_id: id}, function (err, res) {
                            if (res) {
                                countOfDeletedDocuments++;
                            }
                            next(err, res);
                        });
                    }

                }, function (error) {
                    if (error) {
                        clientCallback({message: error});
                    } else {
                        clientCallback(null, countOfDeletedDocuments);
                    }
                });
            }
        });
    };

    /**
     * Executes mongo server side script code
     *
     * @roles UsersWithAccess, Admin
     * @desciption execute serversite script
     *
     * @param {object} data The connection-object.
     * @param {!string} data.connectionString The connection string.
     * @param {!string} data.dbName The database name.
     * @param {string=} data.script The mongo shell script code.
     * @param {!object} request The request object.
     * @param {!function(err, res)} request.getSession Returns the current session object.
     * @param {!function(error, result)} callback The callback.
     */
    pub.executeScript = function (data, request, callback) {
        data = data || {};
        var fullConnectionString = getFullConnectionString(data.connectionString, data.dbName);

        if (!fullConnectionString) {
            return callback(new app.ControllerError(CONNECTION_STRING_ERROR_MESSAGE));
        }

        var files = [
            path.join(app.config.path.modules, 'shell', 'mmsshell.js')
        ];

        async.map(files, fs.readFile, function (error, result) {
            if (error) {
                return callback(error, null);
            }

            var sourcecode = 'return ';

            if (lxHelpers.isArray(result)) {
                result.forEach(function (buf) {
                    sourcecode += buf.toString();
                });
            } else {
                sourcecode += result.toString();
            }

            data.script = data.script || '{}';
            sourcecode = sourcecode.split('\'%%CODE%%\'')[0] + data.script + sourcecode.split('\'%%CODE%%\'')[1];
            connectToDatabase(data, 'executeScript', function (error, db) {
                if (error) {
                    return callback(convertMongoErrorToClientError(error));
                }
                /**/
                db.command({
                    eval: sourcecode
                }, function (error, result) {
                    if (result) {
                        if (result.retval) {
                            if (result.retval instanceof Array) {
                                if (result.retval.length > 100 && data.script.indexOf('find') !== -1) {
                                    result.retval = result.retval.slice(0, 100);
                                    result.message = 'WARNING_LIMIT_QUERY';
                                }
                                result.retval = lxHelpers.arrayMap(result.retval, function (document) {
                                    return convertValuesOfDocumentsForClient(document);
                                });
                            }
                        }
                    }

                    db.close();
                    callback(convertMongoErrorToClientError(error), result);
                });
            });
        });
    };

    /**
     * Get a file from _id with filename and filetype.
     *
     * @param {object} db The db-object.
     * @param request
     * @param callback
     */
    function getFile (db, request, callback) {
        var fileid = new ObjectID(request.fileid);
        var options = {
            root: request.collection || 'fs',
            w: 1,
            fsync: true
        };

        var collection = db.collection(request.collection + '.files');

        // get filename and filetype for download
        collection.findOne({_id: fileid}, {fields: {filename: 1, contentType: 1}}, function (error, fileinfo) {
            if (error) {
                return callback(convertMongoErrorToClientError(error));
            }

            if (!fileinfo) {
                return callback(new app.ControllerError('File not found!'));
            }

            var gridStore = new GridStore(db, fileid, 'r', options);

            gridStore.open(function (error, gridStore) {
                if (error) {
                    return callback(convertMongoErrorToClientError(error));
                }

                gridStore.read(function (error, filedata) {
                    callback(error, filedata, fileinfo);
                    gridStore.close();
                });
            });
        });
    }

    /**
     * Download a file
     *
     * @roles UsersWithAccess, Admin
     * @description Download a file
     *
     * @param request
     * @param callback
     */
    pub.downloadFile = function (request, callback) {
        connectToDatabase(request, 'downloadFile', function (error, db) {
            if (error) {
                return callback(convertMongoErrorToClientError(error));
            }

            getFile(db, request, function (error, filedata, fileinfo) {
                db.close();
                callback(error, filedata, fileinfo);
            });
        });
    };

    /**
     * Returns user thats specified to database
     *
     * @roles UsersWithAccess, Admin
     * @description Returns the users of the specified database
     *
     * @param {object} data The data-object.
     * @param {!string} data.connectionString The connection string with server, port.
     * @param {!string} data.dbName The name of the database.
     * @param {string=} data.login_database The database to authenticate.
     * @param request
     * @param callback
     * @returns {*}
     */
    pub.getDatabaseUsers = function (data, request, callback) {
        connectToDatabase(data, 'getDatabaseUsers', function (error, db) {
            if (error) {
                return callback(convertMongoErrorToClientError(error));
            }

            if (db.mongoVersion === '2.6.' || db.mongoVersion === '3.0.' || db.mongoVersion === '3.2.') {
                var destinationDB = data.dbName;
                data.dbName = 'admin';

                connectToDatabase(data, 'getDatabaseUsers', function (error, adminDB) {
                    adminDB.collection('system.users').find({db: destinationDB}, {pwd: 0}).toArray(function (error, result) {
                        lxHelpers.forEach(result, function (item) {
                            // loop through users
                            var roles = [];
                            item.rolesOfOtherDbs = [];

                            // get roles of a user
                            lxHelpers.forEach(item.roles, function (role) {
                                if (role.db === destinationDB) {
                                    roles.push(role.role);
                                } else {
                                    item.rolesOfOtherDbs.push(role);
                                }
                            });
                            item.originRoles = item.roles;
                            item.roles = roles;
                        });

                        callback(
                            convertMongoErrorToClientError(error),
                            result
                        );

                        adminDB.close();
                        db.close();
                    });
                });
            } else if (db.mongoVersion === '2.4.') {
                db.collection('system.users').find({}, {pwd: 0}).toArray(function (error, result) {
                    callback(
                        convertMongoErrorToClientError(error),
                        result
                    );

                    db.close();
                });
            } else {
                callback(convertMongoErrorToClientError({message: 'Cannot read MongoDB version!'}), null);
                db.close();
            }
        });
    };

    /**
     * Adds or edit a database user
     *
     * @roles UsersWithAccess, Admin
     * @description Adds or edit a database user
     *
     * @param {object} data The data object.
     * @param {!string} data.connectionString The string including server, port.
     * @param {!string} data.dbName The name of the database.
     * @param {!object} data.data The user data.
     * @param {!string} data.data.user The name of the user.
     * @param {string=} data.data._id The id needed to update.
     * @param request
     * @param callback
     * @returns {*}
     */
    pub.setDatabaseUser = function (data, request, callback) {
        var user = (data || {}).data || {};

        if (!user || !user.user) {
            return callback(new app.ControllerError('Missing user informations.'));
        }

        if (!user.pwd && !user.userSource || user.pwd && user.userSource) {
            return callback(new app.ControllerError('Password or userSource required but not both.'));
        }

        // Hash Password
        if (user.pwd) {
            var md5 = require('crypto').createHash('md5');
            var pwd264 = user.pwd;

            // Generate keys used for authentication
            md5.update(user.user + ':mongo:' + user.pwd);

            user.pwd = md5.digest('hex');
        }

        connectToDatabase(data, 'setDatabaseUser', function (error, db) {
            if (error) {
                return callback(convertMongoErrorToClientError(error));
            }

            var userDocument;
            var commandOptions;
            var userinfo = {
                user: user.user,
                roles: user.roles || []
            };

            // create user with mongoDb v2.6. or mongoDb v3.0.
            if (db.mongoVersion === '2.6.' || db.mongoVersion === '3.0.' || db.mongoVersion === '3.2.') {
                if (user.customData) {
                    userinfo.customData = user.customData;
                }

                var roles = [];

                lxHelpers.forEach(user.roles, function (item) {
                    roles.push({role: item, db: data.dbName});
                });

                lxHelpers.forEach(user.rolesOfOtherDbs, function (item) {
                    roles.push(item);
                });

                userinfo.roles = roles;
                userinfo.db = user.db || data.dbName;

                async.auto({
                        findUser: function (next) {
                            data.dbName = 'admin';
                            connectToDatabase(data, 'setDatabaseUser', function (error, adminDB) {
                                adminDB.collection('system.users').find({
                                    db: userinfo.db,
                                    user: userinfo.user
                                }).toArray(function (err, res) {
                                    next(err, res);
                                    adminDB.close();
                                });

                            });
                        },
                        removeUser: ['findUser', function (next, results) {
                            if (results.findUser && results.findUser.length === 1) {
                                db.removeUser(userinfo.user, next);
                            } else {
                                next();
                            }
                        }],
                        addUser: ['removeUser', function (next) {
                            db.addUser(userinfo.user, pwd264, userinfo, function (error) {
                                next(
                                    convertMongoErrorToClientError(error),
                                    (error === null)
                                );
                            });
                        }]
                    },
                    function (error) {
                        if (error) {
                            return callback(new app.ControllerError(error.message));
                        } else {
                            callback(null, (error === null));
                        }

                        db.close();
                    }
                );
            } else {
                // update and insert user with mongoDB v2.4 or less
                userDocument = {
                    user: userinfo.user
                };
                commandOptions = {
                    upsert: true
                };

                var unsetFields = {};

                if (user.pwd) {
                    userinfo.pwd = user.pwd;
                    unsetFields.userSource = 1;
                } else if (user.userSource) {
                    userinfo.userSource = user.userSource;
                    unsetFields.pwd = 1;
                }

                db.collection('system.users').update(userDocument, {
                    $set: userinfo,
                    $unset: unsetFields
                }, commandOptions, function (error) {
                    callback(
                        convertMongoErrorToClientError(error),
                        (error === null)
                    );

                    db.close();
                });
            }
        });
    };

    /**
     * Remove a database user
     *
     * @roles UsersWithAccess, Admin
     * @description Remove a database user
     *
     * @param {object} data The connection object.
     * @param {!string} data.connectionString The string including server, port.
     * @param {!string} data.dbName The name of the database.
     * @param {!string} data.username The name of te user.
     * @param request
     * @param {!function(error, result)} callback The callback.
     * @returns {*}
     */
    pub.removeUserFromDatabase = function (data, request, callback) {
        if (!data || !data.username) {
            return callback(new app.ControllerError('Missing username.'));
        }

        connectToDatabase(data, 'removeUserFromDatabase', function (error, db) {
            if (error) {
                return callback(convertMongoErrorToClientError(error));
            }

            db.removeUser(data.username, function (error, result) {
                callback(
                    convertMongoErrorToClientError(error),
                    (error === null && result === true)
                );

                db.close();
            });
        });
    };

    return pub;
};
