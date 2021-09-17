/*
 * (C) Copyright 2014-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

var path = require('path');
var url = require('url');
var express = require('express');
var minimist = require('minimist');
var ws = require('ws');
var kurento = require('kurento-client');
var fs    = require('fs');
var https = require('https');

var argv = minimist(process.argv.slice(2), {
    default: {
        as_uri: 'https://localhost:8444/',
        ws_uri: 'ws://localhost:8888/kurento'
    }
});

var options =
{
  key:  fs.readFileSync('keys/key.pem'),
  cert: fs.readFileSync('keys/cert.pem')
};

var app = express();

/*
 * Definition of global variables.
 */
var idCounter = 0;
var candidatesQueue = {};
var kurentoClient = null;
var customer = null;
var supporters = [];
var noCustomerMessage = 'No active customter. Try again later...';

/*
 * Server startup
 */
var asUrl = url.parse(argv.as_uri);
var port = asUrl.port;
var server = https.createServer(options, app).listen(port, function() {
    console.log('Kurento Tutorial started');
    console.log('Open ' + url.format(asUrl) + ' with a WebRTC capable browser');
});

var wss = new ws.Server({
    server : server,
    path : '/one2many'
});

function nextUniqueId() {
	idCounter++;
	return idCounter.toString();
}

/*
 * Management of WebSocket messages
 */
wss.on('connection', function(ws) {

	var sessionId = nextUniqueId();
	console.log('Connection received with sessionId ' + sessionId);

    ws.on('error', function(error) {
        console.log('Connection ' + sessionId + ' error');
        stop(sessionId);
    });

    ws.on('close', function() {
        console.log('Connection ' + sessionId + ' closed');
        stop(sessionId);
    });

    ws.on('message', function(_message) {
        var message = JSON.parse(_message);
        console.log('Connection ' + sessionId + ' received message ', message);

        switch (message.id) {
        case 'customer':
			startCustomer(sessionId, ws, message.sdpOffer, function(error, sdpAnswer) {
				if (error) {
					return ws.send(JSON.stringify({
						id : 'customerResponse',
						response : 'rejected',
						message : error
					}));
				}
				ws.send(JSON.stringify({
					id : 'customerResponse',
					response : 'accepted',
					sdpAnswer : sdpAnswer
				}));
			});
			break;

        case 'supporter':
			startSupporter(sessionId, ws, message.sdpOffer, function(error, sdpAnswer) {
				if (error) {
					return ws.send(JSON.stringify({
						id : 'supporterResponse',
						response : 'rejected',
						message : error
					}));
				}

				ws.send(JSON.stringify({
					id : 'supporterResponse',
					response : 'accepted',
					sdpAnswer : sdpAnswer
				}));
			});
			break;

        case 'stop':
            stop(sessionId);
            break;

        case 'onIceCandidate':
            onIceCandidate(sessionId, message.candidate);
            break;

        default:
            ws.send(JSON.stringify({
                id : 'error',
                message : 'Invalid message ' + message
            }));
            break;
        }
    });
});

/*
 * Definition of functions
 */

// Recover kurentoClient for the first time.
function getKurentoClient(callback) {
    if (kurentoClient !== null) {
        return callback(null, kurentoClient);
    }	
    kurento(argv.ws_uri, function(error, _kurentoClient) {
        if (error) {			
            console.log("Could not find media server at address " + argv.ws_uri);
            return callback("Could not find media server at address" + argv.ws_uri
                    + ". Exiting with error " + error);
        }		
        kurentoClient = _kurentoClient;
        callback(null, kurentoClient);
    });
}

function startCustomer(sessionId, ws, sdpOffer, callback) {	
	clearCandidatesQueue(sessionId);

	if (customer !== null) {
		stop(sessionId);
		return callback("Another user is currently acting as customer. Try again later ...");
	}

	customer = {
		id : sessionId,
		pipeline : null,
		webRtcEndpoint : null
	}

	getKurentoClient(function(error, kurentoClient) {
		if (error) {
			stop(sessionId);
			return callback(error);
		}

		if (customer === null) {
			stop(sessionId);
			return callback(noCustomerMessage);
		}		
		kurentoClient.create('MediaPipeline', function(error, pipeline) {			
			if (error) {
				stop(sessionId);
				return callback(error);
			}

			if (customer === null) {
				stop(sessionId);
				return callback(noCustomerMessage);
			}

			customer.pipeline = pipeline;			
			customer.pipeline.create('WebRtcEndpoint', {useDataChannels: true}, function(error, webRtcEndpoint) {
				if (error) {
					stop(sessionId);
					return callback(error);
				}

				if (customer === null) {
					stop(sessionId);
					return callback(noCustomerMessage);
				}

				customer.webRtcEndpoint = webRtcEndpoint;

                if (candidatesQueue[sessionId]) {
                    while(candidatesQueue[sessionId].length) {
                        var candidate = candidatesQueue[sessionId].shift();
                        webRtcEndpoint.addIceCandidate(candidate);
                    }
                }

                webRtcEndpoint.on('OnIceCandidate', function(event) {
                    var candidate = kurento.getComplexType('IceCandidate')(event.candidate);
                    ws.send(JSON.stringify({
                        id : 'iceCandidate',
                        candidate : candidate
                    }));
                });

				webRtcEndpoint.processOffer(sdpOffer, function(error, sdpAnswer) {
					if (error) {
						stop(sessionId);
						return callback(error);
					}

					if (customer === null) {
						stop(sessionId);
						return callback(noCustomerrMessage);
					}

					callback(null, sdpAnswer);
				});

                webRtcEndpoint.gatherCandidates(function(error) {
                    if (error) {
                        stop(sessionId);
                        return callback(error);
                    }
                });

				webRtcEndpoint.connect(webRtcEndpoint, function(error) {
					if (error) {
						stop(sessionId);
						return callback(error);
					}
					console.log('Customer connected to itself');					
				});
            });
        });
	});
}

function startSupporter(sessionId, ws, sdpOffer, callback) {
	clearCandidatesQueue(sessionId);

	if (customer === null || customer.pipeline === null) {
		stop(sessionId);
		return callback(noCustomerMessage);
	}	
	customer.pipeline.create('WebRtcEndpoint', {useDataChannels: true}, function(error, webRtcEndpoint) {
		if (error) {
			stop(sessionId);
			return callback(error);
		}
		supporters[sessionId] = {
			"webRtcEndpoint" : webRtcEndpoint,
			"ws" : ws
		}

		if (customer === null) {
			stop(sessionId);
			return callback(noCustomerMessage);
		}

		if (candidatesQueue[sessionId]) {
			while(candidatesQueue[sessionId].length) {
				var candidate = candidatesQueue[sessionId].shift();
				webRtcEndpoint.addIceCandidate(candidate);
			}
		}

        webRtcEndpoint.on('OnIceCandidate', function(event) {
            var candidate = kurento.getComplexType('IceCandidate')(event.candidate);
            ws.send(JSON.stringify({
                id : 'iceCandidate',
                candidate : candidate
            }));
        });

		webRtcEndpoint.processOffer(sdpOffer, function(error, sdpAnswer) {
			if (error) {
				stop(sessionId);
				return callback(error);
			}
			if (customer === null) {
				stop(sessionId);
				return callback(noCustomerMessage);
			}
			callback(null, sdpAnswer);			
	    });

		webRtcEndpoint.gatherCandidates(function(error) {
			if (error) {
				stop(sessionId);
				return callback(error);
			}
		});		
		customer.webRtcEndpoint.connect(webRtcEndpoint, function(error) {
			if (error) {
				stop(sessionId);
				return callback(error);
			}
			console.log('Customer connected to supporter');			
		});		
	});
}

function clearCandidatesQueue(sessionId) {
	if (candidatesQueue[sessionId]) {
		delete candidatesQueue[sessionId];
	}
}

function stop(sessionId) {
	if (customer !== null && customer.id == sessionId) {
		for (var i in supporters) {
			var supporter = supporters[i];
			if (supporter.ws) {
				supporter.ws.send(JSON.stringify({
					id : 'stopCommunication'
				}));
			}
		}
		customer.pipeline.release();
		customer = null;
		supporters = [];

	} else if (supporters[sessionId]) {
		supporters[sessionId].webRtcEndpoint.release();
		delete supporters[sessionId];
	}

	clearCandidatesQueue(sessionId);

	if (supporters.length < 1 && !customer) {
        console.log('Closing kurento client');
        kurentoClient.close();
        kurentoClient = null;
    }
}

function onIceCandidate(sessionId, _candidate) {
    var candidate = kurento.getComplexType('IceCandidate')(_candidate);

    if (customer && customer.id === sessionId && customer.webRtcEndpoint) {
        console.info('Sending customer candidate');
        customer.webRtcEndpoint.addIceCandidate(candidate);
    }
    else if (supporters[sessionId] && supporters[sessionId].webRtcEndpoint) {
        console.info('Sending supporter candidate');
        supporters[sessionId].webRtcEndpoint.addIceCandidate(candidate);
    }
    else {
        console.info('Queueing candidate');
        if (!candidatesQueue[sessionId]) {
            candidatesQueue[sessionId] = [];
        }
        candidatesQueue[sessionId].push(candidate);
    }
}

app.use(express.static(path.join(__dirname, 'static')));
