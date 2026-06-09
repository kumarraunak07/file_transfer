# Seamless File Transfer

A browser-first MVP for transferring files between PCs and mobile devices. It implements the first executable version of the project plan: QR/link pairing, explicit receiver consent, encrypted WebRTC data-channel transfer, progress feedback, and local transfer history.

## What is implemented

- Cross-device web app served from a local Node server.
- Sender creates a pairing room and shares a QR code or link.
- Receiver opens the link, connects to the sender, and accepts or declines each file.
- File bytes move over a WebRTC data channel. WebRTC provides encrypted transport through DTLS.
- Progress is shown on both devices, with local history stored in each browser.
- The signaling server only coordinates pairing and WebRTC negotiation; it does not store transferred files.

## Run locally

```bash
npm install
npm start
```

Open the printed `http://localhost:4173` URL on the sending device. For phone testing, use the printed LAN URL, and make sure both devices are on the same network.

## MVP boundaries

- This version is a PWA-style implementation rather than native Windows/macOS/Android/iOS apps.
- Same-network transfer is the primary path. WebRTC may use STUN for connection setup, but there is no TURN relay server configured yet.
- Transfers are single-file actions, though multiple files can be selected and sent one at a time.
- Resuming partial files after a dropped connection is not yet implemented.

