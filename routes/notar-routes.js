// notar-routes.js
var path = require('path'),
    app = require(path.resolve(__dirname, '../app')),
    bunyan = require('bunyan'),
    log = bunyan.createLogger({name:'notar-routes', "level": "info"}),
    mongoskin = require('mongoskin'),
    extend=require('node.extend'),
    util = require('util'),
    configPath = path.resolve(__dirname, '../config/'),
    http = require('http'),
    https = require('https'),
    argv=require('yargs')
        .usage("node notar-routes.js [ --ssl ] [--level LOGLEVEL] [--serverdb SERVER_DATABASE")
        .boolean('ssl')
        .argv
    ;


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
    var millis=new Date().valueOf();
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
    } catch (e){
      log.error(e, "writing db");
    }
  });

  app.get('/notar/count', function(req, res, next){
    var start=req.query.start,
        end=req.query.end;
    coll.count({$and : [{$gte:{time:start}}, {$lte:{time:end}}]}, function(err, count){
      if (err){
        log.error(err, "getting count");
        return res.status(500).send("ERROR getting count.");
      }
      res.send(JSON.stringify({count:count}));
    })
  })

  app.post('/notar/validate', function (req, res, next) {
    var hash = req.body.hash,
        signature = req.body.signature,
        id = req.body.id
        ;
    coll.findOne({_id: mongoskin.ObjectId(signature)}, function (err, ob) {
      if (err) {
        log.error(err, "/notar/validate from ip:%s for signature:%s", ip, signature);
        return res.status(500).send("error finding signature")
      }
      if (!ob) {
        log.error("No object for signature:%s", signature);
        return res.send({invalid: true, reason: "no such signature"});
      }
      if (ob.hash == hash && ob.itemid == id) return res.send('OK');
      //else
      coll.update({_id: mongoskin.ObjectId(signature)}, {'$set': {invalid: true}});
      return res.send(JSON.stringify(
          {invalid: true, reason: (ob.hash != hash ? "hash " : "id ") + "does not match"}))
    })
  });

  app.use(function(req, res, next) {
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
  if (argv.ssl) config.ssl=true;
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

  function dbConnectFailure(err)
  {
    log.error('Unable to connect to mongo at %s.\n   ', config.mongodb.urlskel, err.message);
    setTimeout(function(){process.exit(1);}, 3000);
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
