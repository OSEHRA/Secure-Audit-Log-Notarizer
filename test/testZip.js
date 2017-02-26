/** testZip.js
 * Copyright 2017 Zato, Inc.
 *
 * Author: jbroglio
 * Date: 2/26/17
 * Time: 9:52 AM
 */
var fs=require('fs'),
    Zipper=require('jszip'),
    path=require('path'),
    util=require('util'),
    bunyan=require('bunyan'),
    log=bunyan.createLogger({name:'testZip', level:'DEBUG'})
;

process.on('uncaughtException',function(err){
  log.error(err, "Zipping");
  if (err.stack) util.format("%j", err.stack);

})


var zipMem=new Zipper();
var newzip=new Zipper();
zipMem.file("log1.txt", "This is log one");
zipMem.generateNodeStream({type:'nodebuffer',streamFiles:true})
          .pipe(fs.createWriteStream('zipmem.zip'))
          .on('finish', function () {
            // JSZip generates a readable stream with a "end" event,
            // but is piped here in a writable stream which emits a "finish" event.
            console.log("out.zip written.");
            var data ="";
            fs.createReadStream('zipmem.zip','binary')
                .on('data', function (chunk) {
                  data+=chunk;
                })
                .on('close', function () {
                  newzip.loadAsync(data)
                      .then(function (z) {
                        z.file('log2.txt', "This is log 2");
                        z.generateNodeStream({type: 'nodebuffer', streamFiles: true})
                            .pipe(fs.createWriteStream('ziptestb.zip'))
                            .on('finish', function () {
                              // JSZip generates a readable stream with a "end" event,
                              // but is piped here in a writable stream which emits a "finish" event.
                              console.log("out.zip 2 written.");
                            });
                      })
                      .catch(function (err) {
                        log.error(err)
                      })
                })
          })



