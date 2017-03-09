# Secure-Audit-Log-Notarizer

_Audit log protection mechanism for popHealth certification - d(3) criteria_

This module is designed to reveal tampering in database entries. It was designed to accompany PopHealth to protect its audit log.

The idea is that after a break-in to the host computer, or any suspicious action in the database, we need to check to see if information has been tampered with.

## Architecture

The server component, ````routes/notar-routes.js```` uses ````app.js```` to offer itself as a web service. 

The client component ````lib/client.js```` reads a MongoDB collection, hashes each entry and sends the hash and item ID to the server. 

The server enters the ID and the hash into its database and returns the 'notarizing' key to the entry. 

When it is time to check an entry, the client goes through its secured collection, and for each item, sends its hash, ID and the 'notarizing' key. The server checks its database and flags any invalid entries, both in its database and in the return message to the client.

Optionally, the client can also send a ZIP of each item to the server and the server will put those into a big zip file, starting a new zip file when the configured size limit is reached.

## Installation

After cloning from Github, cd into the application directory and run:

````npm install````

If you want to run the server and/or client as a daemon (recommended), also install ````forever````:

````npm install -g forever````

## Usage

For development, server and client can be run on the same host. In production, it is essential that the server run on another host in the LAN. An SSL option is provided for that purpose.

### Server

````node routes/notar-routes.js [--port PORT] [ --ssl ] [--level LOGLEVEL] [--serverdb SERVER_DATABASE ]````

Or as demon:

   ````forever start routes/notar-routes.js [--port PORT] [ --ssl ] [--level LOGLEVEL] [--serverdb SERVER_DATABASE ]````

(See also *Configuration* section.)

### Client

To start monitoring client:

````node lib/client.js [--host NOTARIZER_SERVER] [--ssl] [--config CONFIGPATH] [--level LOGLEVEL]````

Or as daemon:

````forever start lib/client.js [--host NOTARIZER_SERVER] [--ssl] [--config CONFIGPATH] [--level LOGLEVEL]````

### Validation Client

To run validation of the notarizer database collection entries: 

````node lib/client.js --validate [ OPTIONAL_ARGS ]````

## Configuration

There are a number of configuration options in config/config.js. These can be modified to tailor the application to your environment and to avoid the need for any command-line arguments.

### Config items

* MongoDB authentication. If your MongoDB runs with --auth, you must create a credentials.js file in the config/ directory:

    ````echo 'module.exports="USER:PASSWORD@"' > config/credentials.js````

    If your MongoDB installation runs without authentication, then comment out the ````require('./credentials')```` line and remove ````'+cred+'```` from the ````mongodb.urlskel```` entry in config.js

* certs: if running under SSL, you must supply (PEM) certificates and keys here. They may be self-signed (caCert helps with this). 

    (If you have self-signed certificates and test with curl, use ````-k```` to accept the server certificate because curl does not have any provision for self-signed certificates. Also use ````--key CLIENTKEY --cert CLIENTCERT```` to supply client-certificates.)

* ssl: if this is true, then certs must be supplied.

* port: port the server will listen to.

* mongodb: Both client and server information are here (and can be changed independently)

  * mongodb.logs: database collection to be monitored
  * mongodb.nota: server collection where hashes, etc., will be stored
  * mongodb.since: earliest date in logs to consider.

* notarizer: information the client uses to access the server. You will change the ````notarizer.host```` for production use

* zip: configuration for the option to store zipped entries on the server as a backup.

* https: most values are filled in dynamically. 
  
  * https.requestCert : whether client must have a client certificate to access the server.
  * https.rejectUnauthorized: true for production, false if you want to debug authorization. False requires an ````app.use()```` clause which checks ````req.client.authorized```` and perhaps outputs an error message if client is not authorized.

* routes: currently ignored
* requestOpts: for the client; passphrase would be the passphrase on the client key/cert if any.

* sha2: the hash function used to hash the log entries.

