// Serviço mínimo que valida a configuração ao iniciar (RN-BE-061). Usado pelo teste de falha rápida.
import Type from 'typebox';
import { BaseConfigProperties, loadConfigOrExit } from '../../src/index.js';

const Config = Type.Object({
  ...BaseConfigProperties,
  DB_URL: Type.String({ minLength: 1 }),
  API_SECRET: Type.String({ minLength: 8 }),
});

const config = loadConfigOrExit(Config);
console.log(`CONFIG_OK ${config.SERVICE_NAME} ${config.PORT}`);
