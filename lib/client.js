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
    Zipper = null,
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
function getSignature(hash, obid, txt, cb) {
  if (typeof txt === 'function') {
    cb = txt;
    txt = null;
  }
  var opts = extend({
        body: {hash: hash, id: obid},
        method: "POST",
        uri: config.notarizer.url + '/sign'
      },
      options);
  if (txt) {
    if (config.zip.active && !Zipper) Zipper = require('jszip');
    var zipped = new Zipper();
    zipped.file(obid, txt);
    zipped.generateAsync({type: 'string'})
        .then(function (s) {
          opts.body.zipped = s;
          sendIt()
        })
        .catch(function(err){
          log.error(err," generateAsync zip");
        })
  } else sendIt();

  function sendIt() {
    request(opts)
        .then(function (body) {
          return cb(null, body);
        })
        .catch(function (err) {
          log.error(err, "posting log message: %s", obid);
          return cb(err, null)
        })
  }
}

// # validateLogs
// Begins by comparing notarized count with Notarizer's count.
// We do this because log file could keep growing while we are working.
// Then we validate each notarized item.
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
      request(opts)
          .then(function (result) {
            var remoteCount = result.count;
            var remoteTotal = result.total;
            notadb.count({$and: [{time: {$gte: start}}, {time: {$lte: end}}]}, function (err, count) {
              if (err) {
                return log.error(err, "querying log item count")
              }
              if (remoteCount > count) {
                log.error("VALIDATION FAILED: missing notarized items")
              }
              if (remoteTotal != count) {
                log.warn("notarizedTotal:%d != localTotal: %d", remoteTotal, count)
              }
              if (count==remoteCount) log.info("Validating: Local count:%s == remote count:%s", count, remoteCount);
              //
              var skip1 = remoteTotal - count;
              // validate the log entries
              logsdb.findOne({_id: startId}, function (err, doc1) {
                if (err) {
                  return log.error(err, "VALIDATION FAILED while getting 1st log item by id")
                }
                var logStart = doc1.created_at;
                logsdb.findOne({_id: endId}, function (err, doc2) {
                  if (err) {
                    return log.error(err, "VALIDATION FAILED while getting last log item by id")
                  }
                  var logEnd = doc2.created_at;
                  // now validate all entries. By running from notadb, we will verify that every log item is present
                  validateEntries(start, end, function(err, numberValidated){
                    if (err) log.error(err, "validating");
                    else log.info("Number Validated: "+numberValidated);
                    // exit
                    db.close();
                  });
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
var numberValidated=0;
function validateEntries(start, end, cb) {
  var skip = 0, limit = 100;
  validateSome();

  function validateSome() {
    notadb.find({$and: [{time: {$gte: start}}, {time: {$lte: end}}]}).skip(skip).limit(limit).toArray()
        .then(function (keyDocs) {
          if (keyDocs) skip += keyDocs.length;
          else {
            return cb(null, numberValidated);
          }
          var query = [];
          getHash()

          function getHash() {
            if (!keyDocs || !keyDocs.length) {
              if (query.length) {
                var opts = extend(
                    {
                      uri: config.notarizer.url + "/validate",
                      body: query,
                      method: 'POST'
                    }, options);
                return request(opts)
                    .then(function (result) {
                      if (result.failed)log.error("VALIDATION FAILURE: %j", result.failed);
                      else numberValidated=result.numberValidated; // this is cumulative on server for now
                      setImmediate(validateSome);
                    })
                    .catch(function (err) {
                      log.error(err, "Calling notarizer with validation batch. Check server availability.");
                      cb(err,numberValidated);
                    })
              } else return cb(null, numberValidated);
            }
            var kd = keyDocs.shift();
            logsdb.findOne({_id: kd._id}, function (err, logitem) {
              if (err) {
                log.error(err, "VALIDATION ERROR. NO log item for nota entry:%s.", kd._id.toString());
                // keep going to list all the errors
              } else {
                var hash = config.sha2(JSON.stringify(logitem));
                query.push({signature: kd.signature, itemid: kd._id.toString(), hash: hash})
              }
              setImmediate(getHash)
            })
          }
        })
        .catch(function(err){
          log.error(err, "validating");
        })
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
        } else q = {created_at: {$gt: lastLog.created_at}};
        doNotarize();
      })
    }
  })

  var cursor;

  function cursorNext() {
    if (!cursor) return;
    try {
      cursor.nextObject(function (err, doc) {
        if (err) {
          log.error(err, "on cursor.nextObject()--continuing...")
          return setImmediate(notarizeLogs)
        }
        if (!doc) return setImmediate(notarizeLogs);
        var docString = JSON.stringify(doc);
        var hash = config.sha2(docString);
        getSignature(hash, doc._id.toString(), docString, function (err, val) {
          if (err) {
            return notadb.insert({_id: doc._id, signature: "ERROR"}, function (err, ret) {
              if (err) {
                log.error(err, "insertion error for %s", doc._id.toString())
                return setImmediate(cursorNext)
              }
            })
          }

          notadb.findOne({_id: doc._id, signature: "ERROR"}, function (err, ret) {
            // check if we had an error before
            if (err || !ret) {
              notadb.insert({_id: doc._id, signature: val.signature, time: val.time}, function (err, ret) {
                if (err) {
                  log.error(err, "insertion error for %s", doc._id.toString())
                  return setImmediate(cursorNext);
                }
                log.info("Notarized: %s", doc._id);
                config.mongodb.since = doc.created_at;
                return setImmediate(cursorNext);
              })
            } else {
              notadb.update({_id: doc._id}, {$set: {signature: val.signature, time: val.time}},
                  function (err, ret) {
                    if (err) {
                      log.error(err, "insertion error for %s", doc._id.toString())
                      return setImmediate(cursorNext);
                    }
                    log.info("Notarized: %s", doc._id);
                    // NOW we can update for last time seen
                    config.mongodb.since = doc.created_at;
                    return setImmediate(cursorNext);
                  })
            }
          });
        })
      })
    } catch (err) {
      log.error(err, "Cursor error");
      setImmediate(notarizeLogs());
    }
  }

  function doNotarize() {
    cursor = logsdb.find(q, {tailable: true});
    if (!cursor) {
      return log.error(err, "error tailing logs");
    }

    cursorNext();
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