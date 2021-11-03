'use strict';

const $self = {
  rtcConfig: null,
  isPolite: false,
  isMakingOffer: false,
  isIgnoringOffer: false,
  isSettingRemoteAnswerPending: false
};

const $peer = {
  connection: new RTCPeerConnection($self.rtcConfig)
};

/**
* Socket Server Events and Callbacks
*/
const namespace = prepareNamespace(window.location.hash, true);

const sc = io(`/${namespace}`, { autoConnect: false });

registerScEvents();



/* DOM Elements */

const button = document
  .querySelector('#call-button');

const filesForm = document
  .querySelector('#files-form');

button.addEventListener('click', handleButton);

filesForm.addEventListener('submit', handleFilesForm);

document.querySelector('#header h1')
  .innerText = `Welcome to Text Chat #${namespace}`;


/* DOM Events */

function handleButton(e) {
  const button = e.target;
  if (button.className === 'join') {
    button.className = 'leave';
    button.innerText = 'Leave Call';
    joinCall();
  } else {
    button.className = 'join';
    button.innerText = 'Join Call';
    leaveCall();
  }
}

function handleFilesForm(event) {
  event.preventDefault();
  const form = event.target;
  const fileInput = form.querySelector('#files-input');
  const file = fileInput.files[0];
  console.log('Got a file with the name', file.name);
  sendFile($peer, file);
}


function joinCall() {
  sc.open();
  registerRtcEvents($peer);
  establishCallFeatures($peer);
}
function leaveCall() {
  resetCall($peer);
  sc.close();
}

function resetCall(peer) {
  peer.connection.close();
  peer.connection = new RTCPeerConnection($self.rtcConfig);
}

function resetAndRetryConnection(peer) {
  resetCall(peer);
  $self.isMakingOffer = false;
  $self.isIgnoringOffer = false;
  $self.isSettingRemoteAnswerPending = false;
  // Polite peer must suppress initial offer
  $self.isSuppressingInitialOffer = $self.isPolite;
  registerRtcEvents(peer);
  establishCallFeatures(peer);

  // Let the remote peer know we're resetting
  if ($self.isPolite) {
    sc.emit('signal',
      { description:
        { type: '_reset'}
      });
  }
}

/* Data Channels */

function addFeaturesChannel(peer) {
  const fc = peer.connection.createDataChannel('features',
    { negotiated: true, id: 50 });
  fc.onopen = function() {
    $self.features = {
      binaryType: fc.binaryType
    }
    fc.send(JSON.stringify($self.features))
  };
  fc.onmessage = function({data}) {
    peer.features = JSON.parse(data);
  };
}

function sendFile(peer, file) {
  // create a package of file metadata
  const metadata = {
    name: file.name,
    size: file.size,
    type: file.type
  };
  const chunk = 8 * 1024; // 8KiB (kibibyte)
  // console.log(JSON.stringify(metadata));
  // create an asymmetric data channel
  const fdc = peer.connection
    .createDataChannel(`file-${metadata.name}`);


  if (
    !$peer.features ||
    ($self.features.binaryType !== $peer.features.binaryType)
  ) {
    fdc.binaryType = 'arraybuffer';
  }
  console.log(`Lets use the ${fdc.binaryType} data type!`);


  fdc.onopen = async function() {
    // send the metadata, once the data channel opens
    console.log('Created a data channel with ID', fdc.id);
    console.log('Heard datachannel open event.')
    console.log('Use chunk size', chunk);
    fdc.send(JSON.stringify(metadata));

    // send the actual file data
    let data =
      fdc.binaryType === 'blob' ? file : await file.arrayBuffer();

    for (let i = 0; i < metadata.size; i += chunk) {
      console.log('Attempting to send a chunk of data...');
      fdc.send(data.slice(i, i + chunk));
    }

  };
  fdc.onmessage = function() {
    // handle an acknowledgement from the receiving peer
  }
}

function receiveFile(fdc) {
  const chunks = [];
  let receivedBytes = 0;
  let metadata;

  fdc.onmessage = function({ data }) {
    let message = data;
    if (typeof(message) === 'string' &&
      message.startsWith('{')) {
      metadata = JSON.parse(message);
      console.log(`Received metadata: ${message}`);
    } else {
      console.log('Received file data');
      chunks.push(data);
      receivedBytes += data.size ? data.size : data.byteLength;
      console.log('Received bytes so far', receivedBytes);
    }
    // see if we've received all data

    if (receivedBytes === metadata.size) {
      console.log('File transfer complete');
      // TODO: actually handle the complete received data
      const received_file = new Blob(chunks, { type: metadata.type });
      // For handling images:
      const li = document.createElement('li');
      const a = document.createElement('a');
      const download = URL.createObjectURL(received_file);
      const filesReceived = document.querySelector('#files-received');
      a.href = download;
      a.download = metadata.name;
      a.innerText = metadata.name;
      li.appendChild(a);
      filesReceived.appendChild(li);
      a.onclick = function() {
        setTimeout(function() {
          // Wait one second after the click to revoke
          // the object URL
          console.log('Revoking object URL...');
          URL.revokeObjectURL(download)
        }, 1000);
      };

    }
  };


  /*
  const img = document.createElement('img');
  const imgSrc = URL.createObjectURL(file);
  const filesReceived = document.querySelector('#files-received');
  img.src = imgSrc;
  filesReceived.appendChild(img);
  img.onload = function() {
    URL.revokeObjectURL(imgSrc);
  };
  */
}

/* WebRTC Events */

function establishCallFeatures(peer) {
  addFeaturesChannel(peer);
}

function registerRtcEvents(peer) {
  peer.connection
    .onnegotiationneeded = handleRtcNegotiation;
  peer.connection
    .onicecandidate = handleIceCandidate;
  peer.connection
    .ondatachannel = handleRtcDataChannel;
}

async function handleRtcNegotiation() {
  // Don't make an initial offer if suppressing
  if ($self.isSuppressingInitialOffer) return;
  console.log('RTC negotiation needed...');
  // send an SDP description
  $self.isMakingOffer = true;
  try {
    // run SLD the modern way...
    await $peer.connection.setLocalDescription();
  } catch(e) {
    // or, run SLD the old-school way, by manually
    // creating an offer, and passing it to SLD
    const offer = await $peer.connection.createOffer();
    await $peer.connection.setLocalDescription(offer);
  } finally {
    // finally, however this was done, send the
    // localDescription to the remote peer
    sc.emit('signal', { description:
      $peer.connection.localDescription });
  }
  $self.isMakingOffer = false;
}
function handleIceCandidate({ candidate }) {
  sc.emit('signal', { candidate:
    candidate });
}

function handleRtcDataChannel({ channel }) {
  const dc = channel;
  console.log('Heard channel', dc.label,
    'with ID', dc.id);
  if (dc.label.startsWith('file-')) {
    receiveFile(channel);
  }
}

/* Signaling Channel Events */

function registerScEvents() {
  sc.on('connect', handleScConnect);
  sc.on('connected peer', handleScConnectedPeer);
  sc.on('signal', handleScSignal);
  sc.on('disconnected peer', handleScDisconnectedPeer)
}


function handleScConnect() {
  console.log('Connected to signaling channel!');
}
function handleScConnectedPeer() {
  console.log('Heard connected peer event!');
  $self.isPolite = true;
}
function handleScDisconnectedPeer() {
  console.log('Heard disconnected peer event!');
  resetCall($peer);
  registerRtcEvents($peer);
  establishCallFeatures($peer);
}
async function handleScSignal({ description, candidate }) {
  console.log('Heard signal event!');
  if (description) {
    console.log('Received SDP Signal:', description);

    if (description.type === '_reset') {
      resetAndRetryConnection($peer);
      return;
    }

    const readyForOffer =
        !$self.isMakingOffer &&
        ($peer.connection.signalingState === 'stable'
          || $self.isSettingRemoteAnswerPending);

    const offerCollision = description.type === 'offer' && !readyForOffer;

    $self.isIgnoringOffer = !$self.isPolite && offerCollision;

    if ($self.isIgnoringOffer) {
      return;
    }

    $self.isSettingRemoteAnswerPending = description.type === 'answer';
    console.log('Signaling state on incoming description:',
      $peer.connection.signalingState);
    try {
      await $peer.connection.setRemoteDescription(description);
    } catch(e) {
      // For whatever reason, we cannot SRD.
      // Reset and retry the connection.
      resetAndRetryConnection($peer);
      return;
    }
    $self.isSettingRemoteAnswerPending = false;

    if (description.type === 'offer') {
      // generate an answer
      try {
        // run SLD the modern way, to set an answer
        await $peer.connection.setLocalDescription();
      } catch(e) {
        // or, run SLD the old-school way, by manually
        // creating an answer, and passing it to SLD
        const answer = await $peer.connection.createAnswer();
        await $peer.connection.setLocalDescription(answer);
      } finally {
        // finally, however this was done, send the
        // localDescription (answer) to the remote peer
        sc.emit('signal',
          { description:
            $peer.connection.localDescription });
        // also, the polite peer no longer has to suppress
        // initial offers:
        $self.isSuppressingInitialOffer = false;
      }
    }
  } else if (candidate) {
    console.log('Received ICE candidate:', candidate);
    try {
      await $peer.connection.addIceCandidate(candidate);
    } catch(e) {
      if (!$self.isIgnoringOffer) {
        console.error('Cannot add ICE candidate for peer', e);
      }
    }
  }
}

/**
 *  Utility Functions
 */
function prepareNamespace(hash, set_location) {
  let ns = hash.replace(/^#/, ''); // remove # from the hash
  if (/^[0-9]{6}$/.test(ns)) {
    console.log('Checked existing namespace', ns);
    return ns;
  }
  ns = Math.random().toString().substring(2, 8);
  console.log('Created new namespace', ns);
  if (set_location) window.location.hash = ns;
  return ns;
}
