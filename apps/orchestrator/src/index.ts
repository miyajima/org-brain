export default {
  async fetch(): Promise<Response> {
    return new Response("Spec-to-code workflow has been removed.", { status: 410 });
  }
};
