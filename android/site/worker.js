export default {
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(request);
    const url = new URL(request.url);
    if (url.pathname.endsWith('.apk')) {
      const headers = new Headers(response.headers);
      headers.set('content-type', 'application/vnd.android.package-archive');
      const name = url.pathname.split('/').pop() || 'kestrel-mobile.apk';
      headers.set('content-disposition', 'attachment; filename="' + name + '"');
      return new Response(response.body, { status: response.status, headers });
    }
    return response;
  },
};
