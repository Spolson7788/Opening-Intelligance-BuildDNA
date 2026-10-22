export const escapedGateHtml = String.raw`<!DOCTYPE html><html><head><title>Login Redirect</title></head><body><script>
window.onload = function () {
  var url = new URL('https:\/\/app.netlify.com/edge-access?domain=oi-connected-release-candidate.netlify.app');
  var fragment = window.location.hash;
  url.searchParams.set('requested_path', window.location.pathname + window.location.search + fragment);
  window.location.href = url.toString();
};
</script></body></html>`;
