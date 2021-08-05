import { stringify } from "@brillout/json-s";
import { parse } from "@brillout/json-s";
import type { ViteDevServer } from "vite";
import { BodyParsed, Telefunction, Telefunctions } from "../shared/types";
import {
  assert,
  assertUsage,
  cast,
  checkType,
  hasProp,
  isCallable,
  isObject,
  isPromise,
  objectAssign,
} from "./utils";
import { loadTelefuncFilesWithVite } from "../vite/loadTelefuncFilesWithVite";
import {
  TelefuncContextUserProvided,
  TelefuncFiles,
  TelefuncFilesUntyped,
} from "./types";
import { setContext } from "./getContext";
import { Config } from "./createTelefuncCaller";

export { setTelefuncFiles };
export { callTelefunc };

type TelefuncContextRequestProps = {
  _url: string;
  _method: string;
  _body: string | Record<string, unknown>;
  _bodyParsed: BodyParsed;
  _telefunctionName: string;
  _telefunctionArgs: unknown[];
};

type Result = Promise<null | {
  body: string;
  etag: string | null;
  statusCode: 200 | 500;
  contentType: "text/plain";
}>;

async function callTelefunc(args: unknown[], config: Config): Result {
  try {
    return await callTelefunc_(args, config);
  } catch (err: unknown) {
    handleError(err, config);
    return {
      contentType: "text/plain",
      body: "Internal Server Error",
      etag: null,
      statusCode: 500,
    };
  }
}

async function callTelefunc_(args: unknown[], config: Config): Result {
  const { requestPropsParsed, telefuncContext } = parseArgs(args);
  checkType<TelefuncContextUserProvided>(telefuncContext);

  objectAssign(telefuncContext, {
    _isProduction: config.isProduction,
    _root: config.root,
    _viteDevServer: config.viteDevServer,
    _baseUrl: config.baseUrl,
    _disableCache: config.disableCache,
  });

  if (
    requestPropsParsed.method !== "POST" &&
    requestPropsParsed.method !== "post"
  ) {
    return null;
  }

  const requestBodyParsed = parseBody(requestPropsParsed);
  objectAssign(telefuncContext, {
    _url: requestPropsParsed.url,
    _method: requestPropsParsed.method,
    _body: requestBodyParsed.body,
    _bodyParsed: requestBodyParsed.bodyParsed,
    _telefunctionName: requestBodyParsed.bodyParsed.name,
    _telefunctionArgs: requestBodyParsed.bodyParsed.args,
  });
  checkType<TelefuncContextRequestProps>(telefuncContext);

  objectAssign(telefuncContext, config);

  const { telefuncFiles, telefuncs } = await getTelefuncs(telefuncContext);
  objectAssign(telefuncContext, {
    _telefuncFiles: telefuncFiles,
    _telefuncs: telefuncs,
  });
  checkType<{
    _telefuncFiles: TelefuncFiles;
    _telefuncs: Record<string, Telefunction>;
  }>(telefuncContext);

  assertUsage(
    telefuncContext._telefunctionName in telefuncContext._telefuncs,
    `Could not find telefunc \`${
      telefuncContext._telefunctionName
    }\`. Did you reload the browser (or deploy a new frontend) without reloading the server (or deploying the new backend)? Loaded telefuncs: [${Object.keys(
      telefuncContext._telefuncs
    ).join(", ")}]`
  );

  const { telefuncResult, telefuncHasErrored, telefuncError } =
    await executeTelefunc(telefuncContext);
  objectAssign(telefuncContext, {
    _telefuncResult: telefuncResult,
    _telefuncHasError: telefuncHasErrored,
    _telefuncError: telefuncError,
    _err: telefuncError,
  });

  if (telefuncContext._telefuncError) {
    throw telefuncContext._telefuncError;
  }

  {
    const serializationResult = serializeTelefuncResult(telefuncContext);
    assertUsage(
      !("serializationError" in serializationResult),
      [
        `Couldn't serialize value returned by telefunc \`${telefuncContext._telefunctionName}\`.`,
        "Make sure returned values",
        "to be of the following types:",
        "`Object`, `string`, `number`, `Date`, `null`, `undefined`, `Inifinity`, `NaN`, `RegExp`.",
      ].join(" ")
    );
    const { httpResponseBody } = serializationResult;
    objectAssign(telefuncContext, { _httpResponseBody: httpResponseBody });
  }

  {
    let httpResponseEtag: null | string = null;
    if (!telefuncContext._disableCache) {
      const { computeEtag } = await import("./cache/computeEtag");
      const httpResponseEtag = computeEtag(telefuncContext._httpResponseBody);
      assert(httpResponseEtag);
    }
    objectAssign(telefuncContext, {
      _httpResponseEtag: httpResponseEtag,
    });
  }

  return {
    body: telefuncContext._httpResponseBody,
    statusCode: 200,
    etag: telefuncContext._httpResponseEtag,
    contentType: "text/plain",
  };
}

async function executeTelefunc(telefuncContext: {
  _telefunctionName: string;
  _telefunctionArgs: unknown[];
  _telefuncs: Record<string, Telefunction>;
}) {
  const telefunctionName = telefuncContext._telefunctionName;
  const telefunctionArgs = telefuncContext._telefunctionArgs;
  const telefuncs = telefuncContext._telefuncs;
  const telefunc = telefuncs[telefunctionName];

  setContext(telefuncContext, false);

  let resultSync: unknown;
  let telefuncError: unknown;
  let telefuncHasErrored = false;
  try {
    resultSync = telefunc.apply(null, telefunctionArgs);
  } catch (err) {
    telefuncHasErrored = true;
    telefuncError = err;
  }

  let telefuncResult: unknown;
  if (!telefuncHasErrored) {
    assertUsage(
      isPromise(resultSync),
      `Your telefunc ${telefunctionName} did not return a promise. A telefunc should always return a promise. To solve this, you can simply use a \`async function\` (or \`async () => {}\`) instead of a normal function.`
    );
    try {
      telefuncResult = await resultSync;
    } catch (err) {
      telefuncHasErrored = true;
      telefuncError = err;
    }
  }

  return { telefuncResult, telefuncHasErrored, telefuncError };
}

function serializeTelefuncResult(telefuncContext: {
  _telefuncResult: unknown;
}) {
  try {
    const httpResponseBody = stringify(telefuncContext._telefuncResult);
    return { httpResponseBody };
  } catch (serializationError: unknown) {
    return { serializationError };
  }
}

function parseBody({ url, body }: { url: string; body: unknown }) {
  assertUsage(
    body !== undefined && body !== null,
    "`callTelefunc({ body })`: argument `body` should be a string or an object but `body === " +
      body +
      "`. Note that with some server frameworks, such as Express.js and Koa, you need to use a server middleware that parses the body."
  );
  assertUsage(
    typeof body === "string" || isObject(body),
    "`callTelefunc({ body })`: argument `body` should be a string or an object but `typeof body === '" +
      typeof body +
      "'`. (Server frameworks, such as Express.js, provide the body as object if the HTTP request body is already JSON-parsed, or as string if not.)"
  );
  const bodyString = typeof body === "string" ? body : JSON.stringify(body);

  let bodyParsed: unknown;
  try {
    bodyParsed = parse(bodyString);
  } catch (err_) {}
  assertUsage(
    hasProp(bodyParsed, "name", "string") &&
      hasProp(bodyParsed, "args", "array"),
    "`callTelefunc({ body })`: The `body` you provided to `callTelefunc()` should be the body of the HTTP request `" +
      url +
      "`. This is not the case; make sure you are properly retrieving the HTTP request body and pass it to `callTelefunc({ body })`. " +
      "(Parsed `body`: `" +
      JSON.stringify(bodyParsed) +
      "`.)"
  );

  return { body, bodyParsed };
}

function parseArgs(args: unknown[]) {
  const [requestProps, telefuncContext, ...argsRest] = args;
  assertUsage(
    argsRest.length === 0,
    "You are providing more than 2 arguments to `callTelefunc(arg1, arg2)` but `callTelefunc()` accepts only two arguments"
  );
  assertUsage(
    requestProps,
    "`callTelefunc(requestProps, telefuncContext)`: argument `requestProps` is missing."
  );
  assertUsage(
    isObject(requestProps),
    "`callTelefunc(requestProps, telefuncContext)`: argument `requestProps` should be an object."
  );
  assertUsage(
    telefuncContext,
    "`callTelefunc(requestProps, telefuncContext)`: argument `telefuncContext` is missing."
  );
  assertUsage(
    isObject(telefuncContext),
    "`callTelefunc(requestProps, telefuncContext)`: argument `telefuncContext` should be an object."
  );
  assertUsage(
    hasProp(requestProps, "url"),
    "`callTelefunc({ url })`: argument `url` is missing."
  );
  assertUsage(
    hasProp(requestProps, "url", "string"),
    "`callTelefunc({ url })`: argument `url` should be a string."
  );
  assertUsage(
    hasProp(requestProps, "method"),
    "`callTelefunc({ method })`: argument `method` is missing."
  );
  assertUsage(
    hasProp(requestProps, "method", "string"),
    "`callTelefunc({ method })`: argument `method` should be a string."
  );
  assertUsage(
    "body" in requestProps,
    "`callTelefunc({ body })`: argument `body` is missing."
  );

  const requestPropsParsed = {
    url: requestProps.url,
    method: requestProps.method,
    body: requestProps.body,
  };

  return {
    requestPropsParsed,
    telefuncContext,
  };
}

var telefuncFilesManuallySet: undefined | TelefuncFiles;
function setTelefuncFiles(telefuncFiles: TelefuncFiles) {
  telefuncFilesManuallySet = telefuncFiles;
}

async function getTelefuncs(telefuncContext: {
  _viteDevServer?: ViteDevServer;
  _root?: string;
  _isProduction: boolean;
}): Promise<{
  telefuncFiles: TelefuncFiles;
  telefuncs: Record<string, Telefunction>;
}> {
  const telefuncFiles = await getTelefuncFiles(telefuncContext);
  assert(telefuncFiles);
  const telefuncs: Telefunctions = {};
  Object.entries(telefuncFiles).forEach(
    ([telefuncFileName, telefuncFileExports]) => {
      Object.entries(telefuncFileExports).forEach(
        ([exportName, exportValue]) => {
          const telefunctionName = telefuncFileName + ":" + exportName;
          assertTelefunction(exportValue, {
            exportName,
            telefuncFileName,
          });
          telefuncs[telefunctionName] = exportValue;
        }
      );
    }
  );
  cast<TelefuncFiles>(telefuncFiles);
  return { telefuncFiles, telefuncs };
}

async function getTelefuncFiles(telefuncContext: {
  _viteDevServer?: ViteDevServer;
  _root?: string;
  _isProduction: boolean;
}): Promise<TelefuncFilesUntyped> {
  if (telefuncFilesManuallySet) {
    return telefuncFilesManuallySet;
  }
  assert(hasProp(telefuncContext, "_root", "string"));
  const telefuncFiles = await loadTelefuncFilesWithVite(telefuncContext);
  return telefuncFiles;
}

function assertTelefunction(
  telefunction: unknown,
  {
    exportName,
    telefuncFileName,
  }: {
    exportName: string;
    telefuncFileName: string;
  }
): asserts telefunction is Telefunction {
  assertUsage(
    isCallable(telefunction),
    `The telefunc \`${exportName}\` defined in \`${telefuncFileName}\` is not a function. A tele-*func*tion should always be a function.`
  );
}

function handleError(err: unknown, config: Config) {
  // We ensure we print a string; Cloudflare Workers doesn't seem to properly stringify `Error` objects.
  const errStr = (hasProp(err, "stack") && String(err.stack)) || String(err);
  if (!config.isProduction && config.viteDevServer) {
    // TODO: check if Vite already logged the error
  }
  console.error(errStr);
}
