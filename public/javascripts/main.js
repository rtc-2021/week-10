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
  const img = document.createElement('img');
  const imgSrc = URL.createObjectURL(file);
  const filesReceived = document.querySelector('#files-received');
  img.src = imgSrc;
  filesReceived.appendChild(img);
  img.onload = function() {
    URL.revokeObjectURL(imgSrc);
  };
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
