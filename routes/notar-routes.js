// notar-routes.js
var path = require('path'),
    app = require(path.resolve(__dirname, '../app')),
    fs = require('fs'),
    bunyan = require('bunyan'),
    log = bunyan.createLogger({name: 'notar-routes', "level": "info"}),
    mongoskin = require('mongoskin'),
    extend = require('node.extend'),
    util = require('util'),
    Zipper = require('jszip'),
    configPath = path.resolve(__dirname, '../config/'),
    http = require('http'),
    https = require('https'),
    argv = require('yargs')
        .usage("node notar-routes.js [--port PORT] [ --ssl ] [--level LOGLEVEL] [--serverdb SERVER_DATABASE")
        .boolean('ssl')
        .number('port')
        .argv
    ;

var config;

var calls = {
  help: "/notar/help",
  sign: "POST /notar/sign {hash: <hash>}",
  validate: "POST /notar/validate {hash: <hash>, signature: <key>, time:<timestamp>",
  NOTE: "9180 requires authentication"
};
var coll; // db collection

function init() {
  app.get('/notar/help', function (req, res, next) {
    res.send(JSON.stringify(util.format(calls)));
  })

  app.post('/notar/sign', function (req, res, next) {
        var hash = req.body.hash;
        var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
        var id = req.body.id;
        var zipped = req.body.zipped;
        var newzip = new Zipper();
        if (!zipped) return saveIt();
        var zipin = new Zipper();
        zipin.loadAsync(zipped)
            .then(function (z) {
              saveIt(z)
            })
            .catch(function(err){
              log.error(err, "loadasync zipped failed")
            })


        function saveIt(z) {
          if (!z) return signIt();

          function zipIt(newzip) {
            newzip.generateNodeStream({type: 'nodebuffer', streamFiles: true})
                .pipe(fs.createWriteStream(zipFilePath))
                .on('finish', function () {
                  signIt();
                });
          }

          var zipFilePath = path.resolve(config.zip.dir, config.zip.fileName + '.zip');
          if (!fs.existsSync(zipFilePath)) {
            // first time create zip file
            fs.mkdirSync(config.zip.dir);
            return zipIt(z);
          }
          var size = fs.lstatSync(zipFilePath).size;
          if (size >= config.zip.size) {
            var rs = fs.createReadStream(zipFilePath);
            var ws = fs.createWriteStream(zipFilePath + new Date().toString);
            rs.on('open', function (fd) {
              rs.pipe(ws);
            })
            rs.on('error', function (err) {
              log.error(err, "Read copying zip file to backup")
            })
            ws.on('error', function (err) {
              log.error(err, "Write copying zip file to backup")
            })
            ws.on('close', function () {
              zipIt(z); //it's just a new file
            })
          } else {
            // todo: jszip seems to have no way to add to a file on disk (like jar appears to do)
            var data = "";
            fs.createReadStream(zipFilePath, 'binary')
                .on('data', function (chunk) {
                  data += chunk;
                })
                .on('close', function () {
                  newzip.loadAsync(data)
                      .then(function (newzip) {
                        return newzip;
                      })
                      .then(function (newzip) {
                        return newzip.loadAsync(zipped)
                      })
                      .then(function (newzip) {
                        zipIt(newzip);
                      })
                      .catch(function (err) {
                        log.error(err, "Adding new file to zip");
                        // return to client
                        signIt();
                      })
                })
          }
        }

        function signIt() {
          var millis = new Date().valueOf();
          if (!hash) return res.status(400).send("/notar/sign: No hash element in post body");
          try {
            coll.insertOne({ip: ip, itemid: id, hash: hash, time: millis},// time: new Date(body.timestamp)},
                function (err, wresult) {
                  if (err) {
                    log.error(err, "signing hash from %s", ip);
                    return res.status(500).send("/notar/sign: Error inserting hash");
                  }
                  res.send(JSON.stringify({time: millis, signature: wresult.insertedId.toString()}));
                })
          } catch (e) {
            log.error(e, "writing db");
          }
        }
      }
  );

  var numberValidated=0;
  // # count
  // Return count between dates and total in notarization collection
  app.get('/notar/count', function (req, res, next) {
    // this is the first step in validation.
    numberValidated=0;
    var start = parseInt(req.query.start),
        end = parseInt(req.query.end);
    coll.count({}, function (err, total) {
      if (err) {
        log.error(err, "getting total count");
        return res.status(500).send("ERROR getting count.");
      }

      coll.count({$and: [{time: {$gte: start}}, {time: {$lte: end}}]}, function (err, count) {
        if (err) {
          log.error(err, "getting count");
          return res.status(500).send("ERROR getting count.");
        }
        res.send(JSON.stringify({count: count, total: total}));
      })
    })
  })

  app.post('/notar/validate', function (req, res, next) {
    var arr = req.body;
    numberValidated+=arr.length;
    var invalid = [];
    doOne();
    function doOne() {
      if (!arr || !arr.length) {
        log.info("cumulative number validated: %d", numberValidated);
        if (invalid.length) {
          return res.send(JSON.stringify({failed: invalid}))
        } else {
          return res.send({valid: config.notarizer.ok, numberValidated:numberValidated});
        }
      }
      var item = arr.shift();
      var signature = item.signature, itemid=item.itemid, hash = item.hash;
      coll.findOne({_id: mongoskin.ObjectId(signature)}, function (err, ob) {
        if (err) {
          log.error(err, "finding doc with signature: %s", signature);
          return res.status(500).send("processing error. Please check notarizer db and retry.");
        }
        if (!ob) {
          log.error("No object for signature:%s", signature);
          return res.send({invalid: true, reason: "no such signature"});
        }
        if (ob.hash == hash && ob.itemid==itemid) return setImmediate(doOne);
        // errors
        if (ob.hash != hash) invalid.push({invalid: true, reason: "hash does not match", itemid: itemid})
        else if (ob.itemid != itemid) invalid.push({invalid: true, reason: "log item id does not match", itemid: itemid})
        //else
        coll.update({_id: mongoskin.ObjectId(signature)}, {$set: {invalid: true}})
            .then(function (up) {
              setImmediate(doOne);
            })
            .catch(function (err) {
              log.error(err, "updating invalid id")
            })
      })
    }
  })

  app.use(function (req, res, next) {
    var err = new Error('Not Found');
    log.error("Not found. url:%s, query:%j, body:%j", req.url, req.query, req.body);
    err.status = 404;
    next(err);
  });

}
//================  MAIN ======================
if (require.main == module) {
  var configFile = argv.config || path.resolve(configPath, 'config.js');
  config = require(configFile).init();
  if (argv.level) log.level(argv.level);
  if (argv.serverdb) config.mongodb.serverdb = argv.serverdb;
  if (argv.ssl) config.ssl = true;
  if (argv.port) config.port = argv.port;
  options = extend({}, config.requestOpts);
  options.url = config.notarizer.url;
  options.json = true;
  options.jar = true;

  var db;
  try {
    db = mongoskin.MongoClient.connect(
        util.format(config.mongodb.urlskel, config.mongodb.serverdb),
        {native_parser: true});
  }
  catch (err) {
    dbConnectFailure(err);
  }

  coll = db.collection(config.mongodb.nota);

  function dbConnectFailure(err) {
    log.error('Unable to connect to mongo at %s.\n   ', config.mongodb.urlskel, err.message);
    setTimeout(function () {process.exit(1);}, 3000);
  }

  init();
  startServer();
  var server;

  function startServer() {
    if (config.ssl) server = https.createServer(config.https, app);
    else server = http.createServer(app);
    server.listen(config.port);
    console.log(new Date() + ": " + (config.ssl ? "HTTPS" : "HTTP") + " Listening at " + config.port);
  }

}
