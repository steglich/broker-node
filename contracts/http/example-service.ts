import Type from 'typebox';
import { defineHttpContract } from '../src/define.js';

const Ping = Type.Object({
  id: Type.String({ format: 'uuid' }),
  createdAt: Type.String({ format: 'date-time' }),
  processedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
});

export const exampleServiceHttp = defineHttpContract({
  service: 'example-service',
  title: 'example-service',
  version: '1.0.0',
  routes: {
    createPing: {
      method: 'post',
      path: '/v1/pings',
      summary: 'Registra um ping e publica `example.pinged`.',
      auth: 'public',
      responses: {
        202: {
          description: 'Ping aceito.',
          body: Type.Object({ pingId: Type.String({ format: 'uuid' }) }),
        },
      },
    },
    getPing: {
      method: 'get',
      path: '/v1/pings/:id',
      summary: 'Consulta um ping.',
      auth: 'public',
      params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
      responses: {
        200: { description: 'O ping.', body: Ping },
        404: { description: 'Ping inexistente.' },
      },
    },
  },
});

export default exampleServiceHttp;
