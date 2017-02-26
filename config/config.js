/** config.js
 * Copyright 2017 Zato, Inc.
 *
 * Author: jbroglio
 * Date: 2/24/17
 * Time: 7:58 AM
 */
var path = require('path'),
    certPath = path.resolve(__dirname, 'cert'),
    fs = require('fs'),
    util = require('util'),
    bunyan=require('bunyan'),
    log = bunyan.createLogger({name: 'config'}),
    extend = require('node.extend'),
    crypto = require('crypto'),
    cred = require('./credentials')
    ;

// overrides is another config with just the changes filled in.

var config =
{
  site: '',
  certs: {
    clientCert: path.resolve(certPath, 'client.pem'),
    clientKey: path.resolve(certPath, 'client.key'),
    serverKey: path.resolve(certPath, 'server.key'),
    serverCert: path.resolve(certPath, 'server.pem'),
    caCert: path.resolve(certPath, 'ca.pem')
  },
  restart: {
    timeout: 15000,
    limit: 10
  },
  binDir: '/home/zato/bin',
  log: {
    file: 'client.log',
    level: 'INFO'
  },
  ssl: false,
  port: 3000,
  mongodb: {
    urlskel: 'mongodb://'+cred+'localhost:27017/%s?reconnect=true&authSource=admin',
    clientdb: 'pophealth-production',
    serverdb: 'notarization',
    logs: 'logs',
    nota: 'nota',
    since: new Date("2015-01-01")
  },
  providers: [
    'localhost:3000'
  ],
  serverCert: '',
  serverKey: '',
  caCert: '',
  notarizer:{
    host: "localhost",
    port: 3000,
    app: "notar"
  },
  https: {
    key: '',
    cert: '',
    ca: '',
    requestCert: true,
    rejectUnauthorized: false
  },
  routes: {
  },
  requestOpts:{
    key:null,
    cert:null,
    ca:null,
    passphrase:''
  },
  sha2: function(txt){
    return crypto.createHash('sha224').update(txt).digest('hex');
  }
};

function init(overrides) {
  config = extend(true, config, overrides);
  config.clientCert = fs.readFileSync(config.certs.clientCert);
  config.clientKey = fs.readFileSync(config.certs.clientKey);
  config.serverCert = fs.readFileSync(config.certs.serverCert);
  config.serverKey = fs.readFileSync(config.certs.serverKey);

  config.caCert = fs.readFileSync(config.certs.caCert);
  // config.https.key = config.serverKey;
  // config.https.cert = config.serverCert;
  // config.https.ca = config.caCert;
  config.requestOpts.cert = config.clientCert;
  config.requestOpts.key = config.clientKey;
  config.requestOpts.ca = config.caCert;

  return config;
}

exports.init = init;
