const Hapi = require('hapi');
const Inert = require('inert');

module.exports = startServer;

async function startServer(browserDist, wildcardApi) {
  const server = Hapi.Server({
    port: 3000,
    debug: {request: ['internal']},
  });

  server.route({
    method: '*',
    path: '/wildcard/{param*}',
    handler: async (request, h) => {
      const {method, url, headers} = request.raw.req;
      const context = {method, url, headers};

      const {body, statusCode} = await wildcardApi.getApiResponse(context);

      const resp = h.response(body);
      resp.code(statusCode);
      return resp;
    }
  });

  await server.register(Inert);
  server.route({
    method: '*',
    path: '/{param*}',
    handler: {
      directory: {
        path: browserDist,
      }
    }
  });

  await server.start();

  return server.stop;
}
