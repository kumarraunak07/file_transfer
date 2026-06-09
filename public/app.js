const CHUNK_SIZE = 64 * 1024;
const MAX_BUFFERED_AMOUNT = 8 * 1024 * 1024;
const HISTORY_KEY = "seamless-transfer-history";

const params = new URLSearchParams(window.location.search);
const routeRoom = getReceiveRouteRoom();
const initialRoom = routeRoom || params.get("room");
const initialRole = routeRoom || (initialRoom && params.get("role") !== "sender") ? "receiver" : "sender";

const state = {
  role: initialRole,
  roomId: initialRoom,
  peerId: createId(),
  remotePeerId: null,
  socket: null,
  pc: null,
  channel: null,
  selectedFiles: [],
  activeTransfers: new Map(),
  cancelledTransfers: new Set(),
  sendQueue: [],
  sendingTransferId: null,
  inboundTransfers: new Map(),
  activeReceiveId: null
};

const els = {
  senderView: document.querySelector("#senderView"),
  receiverView: document.querySelector("#receiverView"),
  connectionDot: document.querySelector("#connectionDot"),
  connectionState: document.querySelector("#connectionState"),
  newRoomButton: document.querySelector("#newRoomButton"),
  qrCode: document.querySelector("#qrCode"),
  emptyQr: document.querySelector("#emptyQr"),
  pairLink: document.querySelector("#pairLink"),
  copyLinkButton: document.querySelector("#copyLinkButton"),
  roomHint: document.querySelector("#roomHint"),
  dropzone: document.querySelector("#dropzone"),
  fileInput: document.querySelector("#fileInput"),
  fileList: document.querySelector("#fileList"),
  transferProgress: document.querySelector("#transferProgress"),
  receiverProgress: document.querySelector("#receiverProgress"),
  receivePanel: document.querySelector("#receivePanel"),
  historyList: document.querySelector("#historyList"),
  receiverHistoryList: document.querySelector("#receiverHistoryList")
};

boot();

function boot() {
  setMode(state.role);
  renderHistory();
  bindUi();

  if (state.role === "receiver" && state.roomId) {
    connectSignaling();
  }
}

function bindUi() {
  els.newRoomButton.addEventListener("click", createPairingRoom);
  els.copyLinkButton.addEventListener("click", copyPairingLink);
  els.fileInput.addEventListener("change", () => {
    setSelectedFiles([...els.fileInput.files]);
    els.fileInput.value = "";
  });

  ["dragenter", "dragover"].forEach((eventName) => {
    els.dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      els.dropzone.classList.add("ready");
    });
  });

  ["dragleave", "drop"].forEach((eventName) => {
    els.dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      els.dropzone.classList.remove("ready");
    });
  });

  els.dropzone.addEventListener("drop", (event) => {
    setSelectedFiles([...event.dataTransfer.files]);
  });
}

async function createPairingRoom() {
  resetConnection();
  resetSenderTransferUi();
  updateStatus("Creating pairing session...");
  const response = await fetch("/api/rooms");
  if (!response.ok) {
    updateStatus("Could not create a pairing session.", "error");
    return;
  }
  const room = await response.json();
  state.roomId = room.roomId;
  els.qrCode.src = room.qr;
  els.qrCode.classList.add("visible");
  els.emptyQr.classList.add("hidden");
  els.pairLink.value = room.pairUrl;
  els.roomHint.textContent = `Pairing code ${room.roomId}. Expires in about 10 minutes.`;
  connectSignaling();
}

async function copyPairingLink() {
  if (!els.pairLink.value) return;
  await navigator.clipboard.writeText(els.pairLink.value);
  els.copyLinkButton.textContent = "Copied";
  setTimeout(() => {
    els.copyLinkButton.textContent = "Copy";
  }, 1300);
}

function connectSignaling() {
  if (!state.roomId) return;
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  state.socket = new WebSocket(`${protocol}://${location.host}/signal`);

  state.socket.addEventListener("open", () => {
    sendSocket({ type: "join", roomId: state.roomId, peerId: state.peerId });
    updateStatus("Waiting for the other device...");
  });

  state.socket.addEventListener("message", async (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "joined") {
      state.peerId = message.peerId;
    }
    if (message.type === "peer-joined") {
      state.remotePeerId = message.peerId;
      await startPeerConnection(state.role === "sender");
    }
    if (message.type === "signal") {
      state.remotePeerId = message.from;
      await handleSignal(message.data);
    }
    if (message.type === "peer-left") {
      updateStatus("The other device disconnected.", "error");
    }
    if (message.type === "error") {
      updateStatus(message.message, "error");
    }
  });

  state.socket.addEventListener("close", () => {
    if (!state.channel || state.channel.readyState !== "open") {
      updateStatus("Pairing channel closed.", "error");
    }
  });
}

async function startPeerConnection(initiator) {
  if (state.pc) return;
  state.pc = createPeerConnection();

  if (initiator) {
    state.channel = state.pc.createDataChannel("files", { ordered: true });
    configureChannel();
    const offer = await state.pc.createOffer();
    await state.pc.setLocalDescription(offer);
    sendSignal({ description: state.pc.localDescription });
  } else {
    state.pc.addEventListener("datachannel", (event) => {
      state.channel = event.channel;
      configureChannel();
    });
  }
}

function createPeerConnection() {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  });

  pc.addEventListener("icecandidate", (event) => {
    if (event.candidate) sendSignal({ candidate: event.candidate });
  });

  pc.addEventListener("connectionstatechange", () => {
    if (pc.connectionState === "connected") updateStatus("Devices connected. Ready to transfer.", "connected");
    if (["failed", "disconnected"].includes(pc.connectionState)) updateStatus("Connection interrupted. Start a new pairing session to retry.", "error");
  });

  return pc;
}

function configureChannel() {
  state.channel.binaryType = "arraybuffer";
  state.channel.addEventListener("open", () => {
    updateStatus("Secure transfer channel open.", "connected");
    if (state.role === "sender") renderFiles();
  });
  state.channel.addEventListener("message", handleChannelMessage);
  state.channel.addEventListener("close", () => updateStatus("Transfer channel closed."));
}

async function handleSignal(data) {
  if (!state.pc) await startPeerConnection(false);

  if (data.description) {
    await state.pc.setRemoteDescription(data.description);
    if (data.description.type === "offer") {
      const answer = await state.pc.createAnswer();
      await state.pc.setLocalDescription(answer);
      sendSignal({ description: state.pc.localDescription });
    }
  }

  if (data.candidate) {
    await state.pc.addIceCandidate(data.candidate);
  }
}

function sendSignal(data) {
  sendSocket({
    type: "signal",
    roomId: state.roomId,
    to: state.remotePeerId,
    data
  });
}

function sendSocket(message) {
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify(message));
  }
}

function setSelectedFiles(files) {
  const blockedFiles = files.filter((file) => isBlockedUploadFile(file.name));
  state.selectedFiles = files.filter((file) => !isBlockedUploadFile(file.name));

  if (blockedFiles.length > 0) {
    updateStatus(".exe files are blocked. Choose another file type.", "error");
  }

  renderFiles();
  renderBlockedUploadFiles(blockedFiles);
}

function renderFiles() {
  els.fileList.innerHTML = "";

  state.selectedFiles.forEach((file, index) => {
    const row = document.createElement("div");
    row.className = "file-item";
    row.innerHTML = `
      <div class="file-meta">
        <strong>${escapeHtml(file.name)}</strong>
        <span>${formatBytes(file.size)} · ${file.type || "Unknown type"}</span>
      </div>
    `;
    const button = document.createElement("button");
    button.className = "primary";
    button.type = "button";
    button.textContent = "Send";
    button.disabled = !state.channel || state.channel.readyState !== "open";
    button.addEventListener("click", () => requestSend(file));
    const removeButton = document.createElement("button");
    removeButton.className = "secondary";
    removeButton.type = "button";
    removeButton.textContent = "Cancel";
    removeButton.addEventListener("click", () => removeSelectedFile(index));
    const actions = document.createElement("div");
    actions.className = "file-actions";
    actions.append(button, removeButton);
    row.append(actions);
    els.fileList.append(row);
  });
}

function removeSelectedFile(index) {
  state.selectedFiles.splice(index, 1);
  renderFiles();
  updateStatus("Attached file removed.");
}

function renderBlockedUploadFiles(files) {
  for (const file of files) {
    const row = document.createElement("div");
    row.className = "file-item";
    row.innerHTML = `
      <div class="file-meta">
        <strong>${escapeHtml(file.name)}</strong>
        <span>${formatBytes(file.size)} · .exe uploads are not allowed.</span>
      </div>
    `;
    els.fileList.append(row);
  }
}

function requestSend(file) {
  const transferId = createId();
  state.activeTransfers.set(transferId, {
    cancelled: false,
    fileName: file.name
  });
  state.channel.send(JSON.stringify({
    type: "transfer-request",
    transferId,
    name: file.name,
    size: file.size,
    mimeType: file.type || "application/octet-stream"
  }));
  addProgress(els.transferProgress, transferId, `Waiting for approval: ${file.name}`, 0, { cancelable: true });

  const onMessage = async (event) => {
    let message;
    if (typeof event.data !== "string") return;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === "transfer-accepted" && message.transferId === transferId) {
      state.channel.removeEventListener("message", onMessage);
      if (state.activeTransfers.get(transferId)?.cancelled || state.cancelledTransfers.has(transferId)) {
        state.channel.send(JSON.stringify({ type: "transfer-cancelled", transferId }));
        updateProgress(transferId, `Cancelled ${file.name}`, 0, { done: true });
        state.activeTransfers.delete(transferId);
        return;
      }
      queueSend(file, transferId);
    }
    if (message.type === "transfer-declined" && message.transferId === transferId) {
      state.channel.removeEventListener("message", onMessage);
      state.activeTransfers.delete(transferId);
      updateProgress(transferId, "Declined by receiver", 0, { done: true });
    }
  };
  state.channel.addEventListener("message", onMessage);
}

function queueSend(file, transferId) {
  state.sendQueue.push({ file, transferId });
  processSendQueue();
}

async function processSendQueue() {
  if (state.sendingTransferId || state.sendQueue.length === 0) return;
  const next = state.sendQueue.shift();
  state.sendingTransferId = next.transferId;
  await sendFile(next.file, next.transferId);
  state.sendingTransferId = null;
  processSendQueue();
}

async function sendFile(file, transferId) {
  updateProgress(transferId, `Sending ${file.name}`, 0);
  state.channel.send(JSON.stringify({ type: "transfer-start", transferId }));
  let offset = 0;

  while (offset < file.size) {
    if (state.activeTransfers.get(transferId)?.cancelled || state.cancelledTransfers.has(transferId)) {
      state.channel.send(JSON.stringify({ type: "transfer-cancelled", transferId }));
      updateProgress(transferId, `Cancelled ${file.name}`, 0, { done: true });
      state.activeTransfers.delete(transferId);
      return;
    }

    if (state.channel.bufferedAmount > MAX_BUFFERED_AMOUNT) {
      await waitForBuffer();
    }
    const chunk = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
    state.channel.send(chunk);
    offset += chunk.byteLength;
    updateProgress(transferId, `Sending ${file.name}`, offset / file.size);
  }

  if (state.activeTransfers.get(transferId)?.cancelled || state.cancelledTransfers.has(transferId)) {
    state.channel.send(JSON.stringify({ type: "transfer-cancelled", transferId }));
    updateProgress(transferId, `Cancelled ${file.name}`, 0, { done: true });
    state.activeTransfers.delete(transferId);
    return;
  }

  state.channel.send(JSON.stringify({ type: "transfer-complete", transferId }));
  updateProgress(transferId, `Sent ${file.name}`, 1, { done: true });
  saveHistory({ direction: "Sent", name: file.name, size: file.size });
  state.activeTransfers.delete(transferId);
}

function waitForBuffer() {
  return new Promise((resolve) => {
    const check = () => {
      if (!state.channel || state.channel.bufferedAmount <= MAX_BUFFERED_AMOUNT / 2) {
        resolve();
      } else {
        setTimeout(check, 80);
      }
    };
    check();
  });
}

function handleChannelMessage(event) {
  if (typeof event.data !== "string") {
    receiveChunk(event.data);
    return;
  }

  const message = JSON.parse(event.data);
  if (message.type === "transfer-request") {
    showReceiveRequest(message);
  }
  if (message.type === "transfer-start") {
    startReceive(message.transferId);
  }
  if (message.type === "transfer-cancelled") {
    cancelReceive(message.transferId);
  }
  if (message.type === "transfer-complete") {
    completeReceive(message.transferId);
  }
}

function legacyShowReceiveRequest(message) {
  if (state.cancelledTransfers.has(message.transferId)) return;
  state.inbound = {
    transferId: message.transferId,
    name: message.name,
    size: message.size,
    mimeType: message.mimeType,
    received: 0
  };
  state.receivedBuffers = [];
  state.acceptedTransfer = false;

  els.receivePanel.innerHTML = `
    <strong>${escapeHtml(message.name)}</strong>
    <span>${formatBytes(message.size)} · Sender is requesting approval.</span>
    <div class="receive-actions">
      <button class="primary" id="acceptTransfer" type="button">Accept</button>
      <button class="secondary" id="declineTransfer" type="button">Decline</button>
    </div>
  `;
  document.querySelector("#acceptTransfer").addEventListener("click", () => {
    if (state.cancelledTransfers.has(message.transferId)) {
      cancelReceive(message.transferId);
      return;
    }
    state.acceptedTransfer = true;
    state.channel.send(JSON.stringify({ type: "transfer-accepted", transferId: message.transferId }));
    addProgress(els.receiverProgress, message.transferId, `Receiving ${message.name}`, 0);
    els.receivePanel.innerHTML = `<strong>Receiving ${escapeHtml(message.name)}</strong><span>Download will begin when the transfer completes.</span>`;
  });
  document.querySelector("#declineTransfer").addEventListener("click", () => {
    state.channel.send(JSON.stringify({ type: "transfer-declined", transferId: message.transferId }));
    els.receivePanel.innerHTML = `<strong>Transfer declined</strong><span>No file was downloaded.</span>`;
  });
}

function legacyReceiveChunk(chunk) {
  if (!state.inbound || !state.acceptedTransfer) return;
  if (state.cancelledTransfers.has(state.inbound.transferId)) return;
  state.receivedBuffers.push(chunk);
  state.inbound.received += chunk.byteLength;
  updateProgress(state.inbound.transferId, `Receiving ${state.inbound.name}`, state.inbound.received / state.inbound.size);
}

function legacyCompleteReceive(transferId) {
  if (state.cancelledTransfers.has(transferId)) {
    state.receivedBuffers = [];
    return;
  }
  if (!state.inbound || state.inbound.transferId !== transferId) return;
  const blob = new Blob(state.receivedBuffers, { type: state.inbound.mimeType });
  const url = URL.createObjectURL(blob);
  const fileName = state.inbound.name;
  const executable = isExecutableFile(fileName);
  updateProgress(transferId, `Received ${state.inbound.name}`, 1);
  saveHistory({ direction: "Received", name: state.inbound.name, size: state.inbound.size });

  if (executable) {
    renderExecutableSaveOptions(blob, url, fileName);
  } else {
    els.receivePanel.innerHTML = `
      <strong>Transfer complete</strong>
      <span>${escapeHtml(state.inbound.name)} is ready. Click Save file to download it with the correct filename.</span>
      <div class="receive-actions">
        <a class="download-link" id="saveTransfer" href="${url}" download="${escapeHtml(fileName)}">Save file</a>
      </div>
    `;
    document.querySelector("#saveTransfer").addEventListener("click", () => {
      updateStatus("Saving received file...", "connected");
    }, { once: true });
  }

  state.inbound = null;
  state.receivedBuffers = [];
}

function cancelTransfer(transferId) {
  const transfer = state.activeTransfers.get(transferId);
  if (!transfer) return;
  transfer.cancelled = true;
  state.cancelledTransfers.add(transferId);
  state.sendQueue = state.sendQueue.filter((item) => item.transferId !== transferId);
  if (state.channel?.readyState === "open") {
    state.channel.send(JSON.stringify({ type: "transfer-cancelled", transferId }));
  }
  updateProgress(transferId, `Cancelled ${transfer.fileName}`, 0, { done: true });
}

function legacyCancelReceive(transferId) {
  state.cancelledTransfers.add(transferId);
  if (!state.inbound || state.inbound.transferId !== transferId) return;
  updateProgress(transferId, `Cancelled ${state.inbound.name}`, 0, { done: true });
  els.receivePanel.innerHTML = `<strong>Transfer cancelled</strong><span>The sender stopped this transfer.</span>`;
  state.inbound = null;
  state.receivedBuffers = [];
  state.acceptedTransfer = false;
}

function showReceiveRequest(message) {
  if (state.cancelledTransfers.has(message.transferId)) return;
  const transfer = {
    transferId: message.transferId,
    name: message.name,
    size: message.size,
    mimeType: message.mimeType,
    received: 0,
    buffers: [],
    accepted: false
  };
  state.inboundTransfers.set(message.transferId, transfer);

  clearReceiverPlaceholder();
  const card = document.createElement("div");
  card.className = "receive-request";
  card.dataset.receiveId = message.transferId;
  card.innerHTML = `
    <strong>${escapeHtml(message.name)}</strong>
    <span>${formatBytes(message.size)} · Sender is requesting approval.</span>
    <div class="receive-actions">
      <button class="primary accept-transfer" type="button">Accept</button>
      <button class="secondary decline-transfer" type="button">Decline</button>
    </div>
  `;
  els.receivePanel.append(card);

  card.querySelector(".accept-transfer").addEventListener("click", () => {
    if (state.cancelledTransfers.has(message.transferId)) {
      cancelReceive(message.transferId);
      return;
    }
    transfer.accepted = true;
    state.channel.send(JSON.stringify({ type: "transfer-accepted", transferId: message.transferId }));
    addProgress(els.receiverProgress, message.transferId, `Receiving ${message.name}`, 0);
    card.innerHTML = `<strong>${escapeHtml(message.name)}</strong><span>Accepted. Waiting for file data...</span>`;
  });

  card.querySelector(".decline-transfer").addEventListener("click", () => {
    state.channel.send(JSON.stringify({ type: "transfer-declined", transferId: message.transferId }));
    state.inboundTransfers.delete(message.transferId);
    card.innerHTML = `<strong>${escapeHtml(message.name)}</strong><span>Declined. No file was downloaded.</span>`;
  });
}

function startReceive(transferId) {
  const transfer = state.inboundTransfers.get(transferId);
  if (!transfer || !transfer.accepted || state.cancelledTransfers.has(transferId)) return;
  state.activeReceiveId = transferId;
  const card = getReceiveCard(transferId);
  if (card) {
    card.innerHTML = `<strong>${escapeHtml(transfer.name)}</strong><span>Receiving file data...</span>`;
  }
}

function receiveChunk(chunk) {
  if (!state.activeReceiveId) return;
  const transfer = state.inboundTransfers.get(state.activeReceiveId);
  if (!transfer || !transfer.accepted || state.cancelledTransfers.has(transfer.transferId)) return;
  transfer.buffers.push(chunk);
  transfer.received += chunk.byteLength;
  updateProgress(transfer.transferId, `Receiving ${transfer.name}`, transfer.received / transfer.size);
}

function completeReceive(transferId) {
  if (state.cancelledTransfers.has(transferId)) {
    const cancelledTransfer = state.inboundTransfers.get(transferId);
    if (cancelledTransfer) cancelledTransfer.buffers = [];
    return;
  }

  const transfer = state.inboundTransfers.get(transferId);
  if (!transfer || !transfer.accepted) return;

  const blob = new Blob(transfer.buffers, { type: transfer.mimeType });
  const url = URL.createObjectURL(blob);
  const fileName = transfer.name;
  const card = getReceiveCard(transferId) || els.receivePanel;
  updateProgress(transferId, `Received ${transfer.name}`, 1, { done: true });
  saveHistory({ direction: "Received", name: transfer.name, size: transfer.size });

  card.innerHTML = `
    <strong>Transfer complete</strong>
    <span>${escapeHtml(transfer.name)} is ready. Click Save file to download it with the correct filename.</span>
    <div class="receive-actions">
      <a class="download-link save-transfer" href="${url}" download="${escapeHtml(fileName)}">Save file</a>
    </div>
  `;
  card.querySelector(".save-transfer").addEventListener("click", () => {
    updateStatus("Saving received file...", "connected");
  }, { once: true });

  if (state.activeReceiveId === transferId) state.activeReceiveId = null;
  state.inboundTransfers.delete(transferId);
}

function cancelReceive(transferId) {
  state.cancelledTransfers.add(transferId);
  const transfer = state.inboundTransfers.get(transferId);
  if (!transfer) return;

  updateProgress(transferId, `Cancelled ${transfer.name}`, 0, { done: true });
  const card = getReceiveCard(transferId);
  if (card) {
    card.innerHTML = `<strong>${escapeHtml(transfer.name)}</strong><span>The sender stopped this transfer.</span>`;
  }
  if (state.activeReceiveId === transferId) state.activeReceiveId = null;
  transfer.buffers = [];
  state.inboundTransfers.delete(transferId);
}

function clearReceiverPlaceholder() {
  if (els.receivePanel.dataset.ready === "true") return;
  els.receivePanel.innerHTML = "";
  els.receivePanel.dataset.ready = "true";
}

function getReceiveCard(transferId) {
  return els.receivePanel.querySelector(`[data-receive-id="${transferId}"]`);
}

function resetSenderTransferUi() {
  state.selectedFiles = [];
  state.activeTransfers.clear();
  state.cancelledTransfers.clear();
  els.fileInput.value = "";
  els.fileList.innerHTML = "";
  els.transferProgress.innerHTML = "";
}

function renderExecutableSaveOptions(blob, originalUrl, fileName) {
  const zipName = `${fileName}.zip`;
  els.receivePanel.innerHTML = `
    <strong>Transfer complete</strong>
    <span>${escapeHtml(fileName)} is an executable file. Save as ZIP to avoid browser download blocking, then extract it after download.</span>
    <div class="receive-actions">
      <button class="primary" id="saveZipTransfer" type="button">Save as ZIP</button>
      <a class="secondary-link" id="saveOriginalTransfer" href="${originalUrl}" download="${escapeHtml(fileName)}">Save original</a>
    </div>
  `;

  document.querySelector("#saveZipTransfer").addEventListener("click", async () => {
    if (!globalThis.JSZip) {
      updateStatus("ZIP support did not load. Try Save original.", "error");
      return;
    }

    updateStatus("Preparing ZIP download...", "connected");
    const zip = new globalThis.JSZip();
    zip.file(fileName, blob);
    const zippedBlob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
    const zipUrl = URL.createObjectURL(zippedBlob);
    const link = document.createElement("a");
    link.href = zipUrl;
    link.download = zipName;
    link.style.display = "none";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(zipUrl), 30_000);
    updateStatus("ZIP download started.", "connected");
  });

  document.querySelector("#saveOriginalTransfer").addEventListener("click", () => {
    updateStatus("Saving executable. Browser security may ask you to keep it.", "connected");
  }, { once: true });
}

function addProgress(container, transferId, label, value, options = {}) {
  const item = document.createElement("div");
  item.className = "progress-item";
  item.dataset.transferId = transferId;
  item.innerHTML = `
    <div class="progress-header">
      <strong>${escapeHtml(label)}</strong>
    </div>
    <div class="meter"><span style="width: ${Math.round(value * 100)}%"></span></div>
  `;
  if (options.cancelable) {
    const cancelButton = document.createElement("button");
    cancelButton.className = "secondary compact";
    cancelButton.type = "button";
    cancelButton.textContent = "Cancel";
    cancelButton.addEventListener("click", () => cancelTransfer(transferId));
    item.querySelector(".progress-header").append(cancelButton);
  }
  container.prepend(item);
}

function updateProgress(transferId, label, value, options = {}) {
  const item = document.querySelector(`[data-transfer-id="${transferId}"]`);
  if (!item) return;
  item.querySelector("strong").textContent = label;
  item.querySelector(".meter span").style.width = `${Math.round(value * 100)}%`;
  if (options.done) {
    item.querySelector(".progress-header button")?.remove();
  }
}

function saveHistory(entry) {
  const history = getHistory();
  history.unshift({
    ...entry,
    at: new Date().toISOString()
  });
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 12)));
  renderHistory();
}

function renderHistory() {
  const history = getHistory();
  for (const list of [els.historyList, els.receiverHistoryList]) {
    list.innerHTML = history.length ? "" : `<div class="history-item"><span>No transfers yet.</span></div>`;
    for (const item of history) {
      const row = document.createElement("div");
      row.className = "history-item";
      row.innerHTML = `<strong>${item.direction}: ${escapeHtml(item.name)}</strong><span>${formatBytes(item.size)} · ${new Date(item.at).toLocaleString()}</span>`;
      list.append(row);
    }
  }
}

function getHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
  } catch {
    return [];
  }
}

function updateStatus(text, mode = "waiting") {
  els.connectionState.textContent = text;
  els.connectionDot.classList.toggle("connected", mode === "connected");
  els.connectionDot.classList.toggle("error", mode === "error");
}

function setMode(role) {
  els.senderView.classList.toggle("hidden", role !== "sender");
  els.receiverView.classList.toggle("hidden", role !== "receiver");
}

function resetConnection() {
  state.remotePeerId = null;
  state.channel?.close();
  state.pc?.close();
  state.socket?.close();
  state.channel = null;
  state.pc = null;
  state.socket = null;
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function isExecutableFile(fileName) {
  return /\.(exe|msi|bat|cmd|com|scr|ps1)$/i.test(fileName);
}

function isBlockedUploadFile(fileName) {
  return /\.exe$/i.test(fileName);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

function getReceiveRouteRoom() {
  const match = window.location.pathname.match(/^\/receive\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function createId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  if (globalThis.crypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
