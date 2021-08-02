import { telefuncServer } from "./global-instance";
export const server = telefuncServer.telefunctions;
export const { config } = telefuncServer;
export const { getApiHttpResponse } = telefuncServer;
export const { setSecretKey } = telefuncServer;
export { addContext } from "../context/server/addContext";
export { getContext } from './getContext'
export { createTelefuncCaller } from "./createTelefuncCaller";
