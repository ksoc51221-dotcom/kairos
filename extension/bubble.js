// The live camera picture shown in the page while recording. It is an iframe of the extension's own origin, so the camera permission is the
// one granted to Kairos (once), not a prompt on every website. It only displays the camera; the recording happens in the offscreen recorder.
(async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 640 }, facingMode: 'user' }, audio: false });
    document.getElementById('v').srcObject = stream;
    addEventListener('pagehide', () => stream.getTracks().forEach((t) => t.stop()));
  } catch { document.body.classList.add('err'); }
})();
