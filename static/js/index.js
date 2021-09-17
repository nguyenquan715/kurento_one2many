window.onload = () => {
	/* 
		Web socket 
	*/
	let ws = new WebSocket('wss://' + location.host + '/one2many');
	console = new Console();
	window.onbeforeunload = function() {
		ws.close();
	}

	ws.onmessage = function(message) {
		var parsedMessage = JSON.parse(message.data);
		console.info('Received message: ' + message.data);

		switch (parsedMessage.id) {
		case 'customerResponse':
			customerResponse(parsedMessage);
			break;
		case 'supporterResponse':
			supporterResponse(parsedMessage);
			break;
		case 'stopCommunication':
			dispose();
			break;
		case 'iceCandidate':
			webRtcPeer.addIceCandidate(parsedMessage.candidate)
			break;
		default:
			console.error('Unrecognized message', parsedMessage);
		}
	}

	function customerResponse(message) {
		if (message.response != 'accepted') {
			var errorMsg = message.message ? message.message : 'Unknow error';
			console.warn('Call not accepted for the following reason: ' + errorMsg);
			dispose();
		} else {
			webRtcPeer.processAnswer(message.sdpAnswer);
			console.log("Customer connected");
		}
	}

	function supporterResponse(message) {
		if (message.response != 'accepted') {
			var errorMsg = message.message ? message.message : 'Unknow error';
			console.warn('Call not accepted for the following reason: ' + errorMsg);
			dispose();
		} else {
			webRtcPeer.processAnswer(message.sdpAnswer);
			console.log("Supporter connected");
		}
	}

	/* 
		Create peer connection, data channel 
	*/
	let webRtcPeer;
	let peerConnection;
	let channel;
	const mediaStreamConstraints = {
		video: false,
		audio: true
	};
	document.getElementById('customer').addEventListener('click', function() { customer(); } );
	document.getElementById('supporter').addEventListener('click', function() { supporter(); } );
	document.getElementById('stop').addEventListener('click', function() { stop(); } );	

	function customer() {
		if (!webRtcPeer) {		
			peerConnection = new RTCPeerConnection();
			console.log('Created customer peer connection object');

			channel = peerConnection.createDataChannel('sendDataChannel');
			// channel.binaryType = 'arraybuffer';
			console.log('Created send data channel');

			channel.addEventListener('open', onSendChannelStateChange);
			channel.addEventListener('close', onSendChannelStateChange);			
			channel.addEventListener('error', onError);
			
			var options = {
				peerConnection: peerConnection,	
				mediaConstraints: mediaStreamConstraints,	
				onicecandidate : onIceCandidate
			}

			webRtcPeer = kurentoUtils.WebRtcPeer.WebRtcPeerSendrecv(options, function(error) {
				if(error) return onError(error);

				this.generateOffer(onOfferCustomer);
			});
		}
	}

	function onOfferCustomer(error, offerSdp) {
		if (error) return onError(error);

		var message = {
			id : 'customer',
			sdpOffer : offerSdp
		};
		sendMessage(message);
	}

	function supporter() {
		if (!webRtcPeer) {		
			peerConnection = new RTCPeerConnection();
			console.log('Created supporter peer connection object');
			
			channel = peerConnection.createDataChannel('receiveDataChannel');
			// channel.binaryType = 'arraybuffer';
			console.log('Created receive data channel');
			
			channel.onmessage = onReceiveMessageCallback;
			channel.onopen = onReceiveChannelStateChange;
			channel.onclose = onReceiveChannelStateChange;

			var options = {	
				peerConnection: peerConnection,			
				mediaConstraints: mediaStreamConstraints,		
				onicecandidate : onIceCandidate
			}

			webRtcPeer = kurentoUtils.WebRtcPeer.WebRtcPeerRecvonly(options, function(error) {
				if(error) return onError(error);

				this.generateOffer(onOfferSupporter);				
			});			
		}
	}

	function onOfferSupporter(error, offerSdp) {
		if (error) return onError(error)

		var message = {
			id : 'supporter',
			sdpOffer : offerSdp
		}
		sendMessage(message);
	}

	function onIceCandidate(candidate) {
		console.log('Local candidate' + JSON.stringify(candidate));

		var message = {
			id : 'onIceCandidate',
			candidate : candidate
		}
		sendMessage(message);
	}

	function stop() {
		if (webRtcPeer) {
			var message = {
				id : 'stop'
			}
			sendMessage(message);
			dispose();
		}
	}

	function dispose() {		
		if (channel) {		
			channel.close();	
			channel = null;		
			console.log('Closed data channels');
		}
		if(peerConnection) {		
			peerConnection.close();
			peerConnection = null;
			console.log('Closed peer connections');
		}				

		if (webRtcPeer) {
			webRtcPeer.dispose();
			webRtcPeer = null;
		}	
	}

	function sendMessage(message) {
		var jsonMessage = JSON.stringify(message);
		console.log('Sending message: ' + jsonMessage);
		ws.send(jsonMessage);
	}

	/*
		Send file from customer to supporter
	*/
	let fileReader;
	const fileInput = document.querySelector('input#fileInput');
	const abortButton = document.querySelector('button#abortButton');
	const downloadAnchor = document.querySelector('a#download');
	const sendProgress = document.querySelector('progress#sendProgress');
	const receiveProgress = document.querySelector('progress#receiveProgress');
	const sendFileButton = document.querySelector('button#sendFile');

	let receiveBuffer = [];
	let receivedSize = 0;

	sendFileButton.addEventListener('click', () => sendData());
	abortButton.addEventListener('click', () => {
		if (fileReader && fileReader.readyState === 1) {
			console.log('Abort read!');
			fileReader.abort();
		}
	});
	fileInput.addEventListener('change', handleFileInputChange, false);
	async function handleFileInputChange() {
		const file = fileInput.files[0];
		if (!file) {
			console.log('No file chosen');
		} else {
			sendFileButton.disabled = false;
		}
	}

	function sendData() {
		if (!channel) {
			console.error('Connection has not been initiated. ');
			return;
		} else if (channel.readyState === 'closed') {
			console.error('Connection was lost. Peer closed the connection.');
			return;
		}				

		const file = fileInput.files[0];		
		console.log(`File is ${[file.name, file.size, file.type, file.lastModified].join(' ')}`);	
		// Handle 0 size files.			
		if (file.size === 0) {	  
			return;
		}		
		sendProgress.max = file.size;
		sendProgress.value = 0;		
				
		fileReader = new FileReader();
		fileReader.readAsDataURL(file);		
		fileReader.addEventListener('error', error => console.error('Error reading file:', error));
		fileReader.addEventListener('abort', event => console.log('File reading aborted:', event));
		fileReader.onload = onReadAsDataUrl;		
	}

	function onReadAsDataUrl(event, text) {
		const chunkLength = 16384;	
		const data = {};
		if (event){
			text = event.target.result; // on first invocation
		}		
		const len = text.length;		
		channel.send(len);
		console.log(`Sending ${len} bytes`);
		const n = len / chunkLength | 0;				
		// split the photo and send in chunks
		for (let i = 0; i < n; i++) {
			let start = i * chunkLength;
			let end = (i + 1) * chunkLength;
			console.log(start + ' - ' + (end - 1));
			data.message = text.slice(start, end);
			channel.send(JSON.stringify(data));
			sendProgress.value += data.message.length;
		}
		// send the reminder, if any
		if ( len % chunkLength) {
			console.log('last ' + len % chunkLength + ' byte(s)');
			data.message = text.slice(n * chunkLength);			
			channel.send(JSON.stringify(data));
			sendProgress.value += data.message.length;
		}				
	
	}
	
	let fileSize;
	function onReceiveMessageCallback(event) {		    	
		console.log("Receiving data...");
		const data = JSON.parse(event.data);		
		if (typeof data === 'number') {
			fileSize = parseInt(data);
			receiveProgress.max = fileSize;			
			receiveBuffer = [];
			receivedSize = 0;			
			console.log('Expecting a total of ' + fileSize + ' bytes');
			downloadAnchor.textContent = '';
			downloadAnchor.removeAttribute('download');
			if (downloadAnchor.href) {
				URL.revokeObjectURL(downloadAnchor.href);
				downloadAnchor.removeAttribute('href');
			}
			return;
		}		

		console.log(`Received Message ${data.message.length}`);
		receiveBuffer.push(data.message);
		receivedSize += data.message.length;
		receiveProgress.value = receivedSize;
		
		if (receivedSize === fileSize) {
			const today = new Date();						

			const fileName = today.getTime();			
			saveToDisk(receiveBuffer.join(''), fileName);
			receiveBuffer = [];				
		}
	}

	function saveToDisk(fileUrl, fileName) {
		downloadAnchor.href = fileUrl;
		downloadAnchor.download = fileName;
		downloadAnchor.textContent = `Click to download file`;
		downloadAnchor.style.display = 'block';		
	}
	
	function onSendChannelStateChange() {
		if (channel) {
			const {readyState} = channel;
			console.log(`Send channel state is: ${readyState}`);
			if (readyState === 'open') {
				abortButton.disabled = true;
				sendFileButton.disabled = false;
			}
			if (readyState === 'close') {
				abortButton.disabled = true;
				sendFileButton.disabled = true;
			}
		}
	} 
	
	async function onReceiveChannelStateChange() {
		if (channel) {
			const readyState = channel.readyState;
			console.log(`Receive channel state is: ${readyState}`);		
		}
	}

	function onError(error) {
		if (error){
			console.error(error);
			stop();
		}
	}

	/**
	 * Lightbox utility (to display media pipeline image in a modal dialog)
	 */
	$(document).delegate('*[data-toggle="lightbox"]', 'click', function(event) {
		event.preventDefault();
		$(this).ekkoLightbox();
	});
}