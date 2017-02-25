/** client.js
 * Copyright 2017 Zato, Inc.
 *
 * Author: jbroglio
 * Date: 2/24/17
 * Time: 7:59 AM
 */
var bunyan = require('bunyan'),
    log = bunyan.createLogger({name:'client',level: 'INFO'}),
    util=require('util'),
    path=require('path'),
    request = require('request'),
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
    request.post(options, function (err, ret) {
    if (err) {
      log.error(err, "posting log message: %s", obid)
      return cb(err, null)
    }
    return cb(null, JSON.parse(ret));
  })
}

function validateLogs(){

}

function notarizeLogs() {
  var q = {
    ts: {
      $gt: new mongoskin.BSONPure.Timestamp(0, config.mongodb.since || (Date.now() / 1000)),
    }
  };

  // if (options.ns) {
  //   q.ns = options.ns;
  // }

  logs.find(q, {tailable: true}, function (err, cursor) {
    if (err) {
      return self.emit("error", err);
    }

    var cursorStream = cursor.stream();

    cursorStream.on("data", function (doc) {
      var hash = config.sha2(doc.toString())
      getSignature(hash, doc._id.toString(), function (err, val) {
        if (err) {
          return nota.insert({_id: doc._id, signature: "ERROR"}, function (err, ret) {
            if (err) {
              log.error(err, "insertion error for %s", doc._id.toString())
              return
            }
          })
        }
        nota.find({_id: doc._id, signature: "ERROR"}, function (err, ret) {
          // check if we had an error before
          if (err || !ret || !ret.length) {
            nota.insert({_id: doc._id, signature: val.signature}, function (err, ret) {
              if (err) {
                return log.error(err, "insertion error for %s", doc._id.toString())
              }
              log.info("Notarized: %s", doc._id);
              config.mongodb.since = doc.created_at;
            })
          } else {
            nota.update({_id: doc._id}, {$set: {signature: val.signature}},
                function (err, ret) {
                  if (err) {
                    return log.error(err, "insertion error for %s", doc._id.toString())
                  }
                  log.info("Notarized: %s", doc._id);
                  // NOW we can update for last time seen
                  config.mongodb.since = doc.created_at;
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
  //================  MAIN ======================
  if (require.main == module) {
    var configFile = argv.config || path.resolve(configPath, 'config.js');
    if (argv.clientdb) config.mongodb.clientdb = argv.clientdb;
    if (argv.ssl) config.ssl=true;
    if (argv.host) config.notarizer.host=argv.host;
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
    notadb = db.collection(config.mongodb.nota)
    config.notarizer.url=util.format("%s://%s:%d/%s",
        (config.ssl? "https" : "http"),
        config.notarizer.host,config.notarizer.port,config.notarizer.app);

    request.get(config.notarizer.url, options, function (err, ret) {
      if (err) {
        log.error(err, "test login failed")
        process.exit(1);
      }
    })
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