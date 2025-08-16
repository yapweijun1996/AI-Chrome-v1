// WebRTC handler for AI Chrome Extension

class WebRTC {
  constructor(onMessageCallback) {
    this.peerConnection = new RTCPeerConnection();
    this.dataChannel = null;
    this.onMessageCallback = onMessageCallback;

    this.peerConnection.ondatachannel = event => {
      this.dataChannel = event.channel;
      this.dataChannel.onmessage = this.onMessageCallback;
    };
  }

  async createOffer() {
    this.dataChannel = this.peerConnection.createDataChannel('ai-channel');
    this.dataChannel.onmessage = this.onMessageCallback;

    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);

    return offer;
  }

  async createAnswer(offer) {
    await this.peerConnection.setRemoteDescription(offer);
    const answer = await this.peerConnection.createAnswer();
    await this.peerConnection.setLocalDescription(answer);

    return answer;
  }

  async setAnswer(answer) {
    await this.peerConnection.setRemoteDescription(answer);
  }

  sendMessage(message) {
    if (this.dataChannel) {
      this.dataChannel.send(JSON.stringify(message));
    }
  }
}

export default WebRTC;