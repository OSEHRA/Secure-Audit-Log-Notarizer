/** client.js
 * Copyright 2017 Zato, Inc.
 *
 * Author: jbroglio
 * Date: 2/24/17
 * Time: 7:59 AM
 */
var bunyan = require('bunyan'),
    log = bunyan.createLogger({name: 'client', level: 'INFO'}),
    util = require('util'),
    path = require('path'),
    request = require('request-promise'),
    argv = require('yargs')
        .usage('node client.js [--host NOTARIZER_SERVER] [--ssl] [--config CONFIGPATH] [--level LOGLEVEL] [--validate]')
        .boolean('ssl')
        .argv,
    mongoskin = require('mongoskin'),
    extend = require('node.extend'),
    configPath = path.resolve(__dirname, '../config/')
    ;

var config, options, db, logsdb, notadb;
var cursorOptions = {
  tailable: true,
  awaitdata: true,
  numberOfRetries: -1
};

var username;
var password;
function getSignature(hash, obid, cb) {
  var opts = extend({
        body: {hash: hash, id: obid},
        method: "POST",
        uri: config.notarizer.url + '/sign'
      },
      options);
  request(opts)
      .then(function (body) {
        return cb(null, body);
      })
      .catch(function (err) {
        log.error(err, "posting log message: %s", obid);
        return cb(err, null)
      })
}

function validateLogs() {
  notadb.findOne({}, {sort: [["time", "asc"]]}, function (err, doc) {
    if (err) {
      return log.error(err, "querying for validation count start")
    }
    var start = doc.time;
    var startId = doc._id;
    notadb.findOne({}, {sort: [["time", "desc"]]}, function (err, doc2) {
      if (err) {
        return log.error(err, "querying for validation count end")
      }
      var end = doc2.time;
      var endId = doc._id;
      var opts = extend({
        uri: config.notarizer.url + '/count',
        qs: {start: start, end: end},
        method: 'GET'
      }, options);
      request.(opts)
          .then(function (result) {

            var remoteCount = result.count;
            notadb.count({$and: [{time: {$gte: start}}, {time: {$lte: end}}]}, function (err, count) {
              if (err) {
                return log.error(err, "querying log item count")
              }
              if (remoteCount != count) {
                log.error("VALIDATION FAILED: missing notarized items")
              }
              // now make sure that the logs count is the same
              logsdb.findOne({_id: startId}, function (err, doc1) {
                if (err) {
                  return log.error(err, "VALIDATION FAILED: getting 1st log item by id")
                }
                var logStart = doc1.created_at;
                logsdb.findOne({_id: endId}, function (err, doc2) {
                  if (err) {
                    return log.error(err, "VALIDATION FAILED: getting last log item by id")
                  }
                  var logEnd = doc2.created_at;
                  // now validate all entries. By running from notadb, we will verify that every log item is present
                  validateEntries(start, end);
                })
              })
            })
          })
          .catch(function (err) {
            return log.error(err, "requesting validation count")
          })
    })
  })
}

function validateEntries(start, end, cb) {
  var skip = 0, limit = 100;

  function validateSome() {
    var keyDocs = notadb.find({$and: [{time: {$gte: start}}, {time: {$lte: end}}]}).skip(skip).limit(limit).toArray();
    if (keyDocs) skip += keyDocs.length;
    var query = [];

    function getHash() {
      if (!keyDocs || !keyDocs.length) {
        if (query.length) {
          var opts = extend(
              {
                uri: config.notarizer.url + "/validate",
                body: query,
                method: 'POST'
              }, options);
          request(opts)
              .then(function (result) {
                if (result != "OK")log.error("VALIDATION FAILURE: %j", result);
                setImmediate(validateSome);
              })
              .catch(function (err) {
                log.error(err, "Calling notarizer with validation batch. Check server availability.");
                return cb(err);
              })
        } else cb(null);
      }
      var kd = keyDocs.shift();
      logsdb.findOne({_id: kd._id}, function (err, logitem) {
        if (err) {
          log.error(err, "VALIDATION ERROR. NO log item for nota entry:%s.", kd._id.toString());
          // keep going to list all the errors
        } else {
          var hash = config.sha2(JSON.stringify(logitem));
          query.push({id: kd._id.toString(), hash: hash})
        }
        setImmediate(getHash)
      })
    }
  }
}

function notarizeLogs() {
  var q;
  notadb.findOne({signature: {$ne: "ERROR"}}, {sort: [["time", "desc"]]}, function (err, lastnota) {
    if (err || !lastnota) {
      if (err) log.error(err, "finding last nota doc");
      q = {};
      doNotarize();
    } else {
      var arr = logsdb.findOne({_id: lastnota._id}, function (err, lastLog) {
        if (err) {
          log.error(err, "finding last logs doc");
          q = {};
        } else q = {time: {$gt: lastLog.created_at.valueOf()}};
        doNotarize();
      })
    }
  })

  function doNotarize() {
    logsdb.find(q, {tailable: true}, function (err, cursor) {
      if (err) {
        return log.error(err, "error tailing logs");
      }

      var cursorStream = cursor.stream();

      cursorStream.on("data", function (doc) {
        var hash = config.sha2(JSON.stringify(doc));
        cursorStream.pause();
        getSignature(hash, doc._id.toString(), function (err, val) {
          if (err) {
            return notadb.insert({_id: doc._id, signature: "ERROR"}, function (err, ret) {
              if (err) {
                log.error(err, "insertion error for %s", doc._id.toString())
                return cursorStream.resume();
              }
            })
          }
          notadb.findOne({_id: doc._id, signature: "ERROR"}, function (err, ret) {
            // check if we had an error before
            if (err || !ret) {
              notadb.insert({_id: doc._id, signature: val.signature, time: val.time}, function (err, ret) {
                if (err) {
                  log.error(err, "insertion error for %s", doc._id.toString())
                  return cursorStream.resume();
                }
                log.info("Notarized: %s", doc._id);
                config.mongodb.since = doc.created_at;
                return cursorStream.resume();
              })
            } else {
              notadb.update({_id: doc._id}, {$set: {signature: val.signature}},
                  function (err, ret) {
                    if (err) {
                      return log.error(err, "insertion error for %s", doc._id.toString())
                    }
                    log.info("Notarized: %s", doc._id);
                    // NOW we can update for last time seen
                    config.mongodb.since = doc.created_at;
                    return cursorStream.resume();
                  })
            }
          });
        })
      })

      cursorStream.on("error", function (err) {
        log.error(err, "error");
        setImmediate(notarizeLogs);
      });

      cursorStream.on("end", function () {
        setImmediate(openLog);
      });
    });
  }
}
//================  MAIN ======================
if (require.main == module) {
  var configFile = argv.config || path.resolve(configPath, 'config.js');
  if (argv.clientdb) config.mongodb.clientdb = argv.clientdb;
  if (argv.ssl) config.ssl = true;
  if (argv.host) config.notarizer.host = argv.host;
  if (argv.level) log.level(argv.level);
  config = require(configFile).init();
  options = extend({}, config.requestOpts);
  options.json = true;
  options.jar = true;
  try {
    db = mongoskin.MongoClient.connect(
        util.format(config.mongodb.urlskel, config.mongodb.clientdb),
        {native_parser: true});
  } catch (err) {
    dbConnectFailure(err);
  }

  logsdb = db.collection(config.mongodb.logs);
  notadb = db.collection(config.mongodb.nota);
  config.notarizer.url = util.format("%s://%s:%d/%s",
      (config.ssl ? "https" : "http"),
      config.notarizer.host, config.notarizer.port, config.notarizer.app);

  if (argv.validate)
    validateLogs();
  else
    notarizeLogs();

  function dbConnectFailure(err) {
    var loc = config.mongodb.urlskel.indexOf('@') + 1
    log.error(err, 'Unable to connect to mongo at %s.\n   ', config.mongodb.urlskel.substring(loc));
    cleanup();
    process.exit(1);
  }

}