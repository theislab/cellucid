/**
 * The other addresses of one public Amazon S3 object.
 *
 * S3 answers every object at several host names: virtual-hosted
 * (`<bucket>.s3.<region>.amazonaws.com/<key>`), path-style
 * (`s3.<region>.amazonaws.com/<bucket>/<key>`), and both again on the
 * dual-stack endpoint (`s3.dualstack.<region>.amazonaws.com`). Each answers
 * with the same bytes, the same `ETag` and the same CORS headers (measured
 * on the CELLxGENE Census bucket: four hosts, one `ETag`, `Access-Control-
 * Allow-Origin: *` from each). S3 speaks only HTTP/1.1, and a browser keeps
 * six connections to one host, so a file read through many small requests (a
 * chunk index's nodes, a cell-major matrix's row pointers) waits on six round
 * trips at a time. Spread over the object's addresses, its requests run on six
 * connections to each (`httpByteSource` mirrors).
 *
 * Only an unsigned URL has other addresses: a signed one (`X-Amz-Signature`,
 * a pre-signed link) signs its host. A bucket whose name holds a dot has no
 * virtual-hosted HTTPS address its certificate covers, so it keeps its own.
 *
 * @module formats/io/s3
 */

/** `<bucket>.s3.<region>.amazonaws.com`, `<bucket>.s3.dualstack.<region>.amazonaws.com`. */
const VIRTUAL_HOSTED = /^([a-z0-9][a-z0-9-]{1,61}[a-z0-9])\.s3(?:\.dualstack)?\.([a-z0-9-]+)\.amazonaws\.com$/;
/** `s3.<region>.amazonaws.com`, `s3.dualstack.<region>.amazonaws.com`. */
const PATH_STYLE = /^s3(?:\.dualstack)?\.([a-z0-9-]+)\.amazonaws\.com$/;
/** The query parameters of a pre-signed URL (SigV4, SigV2). */
const SIGNED = ['X-Amz-Signature', 'X-Amz-Credential', 'Signature', 'AWSAccessKeyId'];

/**
 * The other addresses of the object `url` names, when it is an unsigned
 * HTTPS URL of a regional S3 endpoint; else none.
 *
 * @param {string} url
 * @returns {string[]} Every address of the object but `url` itself
 */
export function equivalentS3Urls(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  if (parsed.protocol !== 'https:' || parsed.port !== '' || parsed.username !== '' || parsed.password !== '') return [];
  if (SIGNED.some(name => parsed.searchParams.has(name))) return [];
  const host = parsed.hostname.toLowerCase();
  let bucket;
  let region;
  let key;
  const virtual = VIRTUAL_HOSTED.exec(host);
  const pathStyle = virtual === null ? PATH_STYLE.exec(host) : null;
  if (virtual !== null) {
    [, bucket, region] = virtual;
    key = parsed.pathname;
  } else if (pathStyle !== null) {
    region = pathStyle[1];
    const slash = parsed.pathname.indexOf('/', 1);
    if (slash < 0) return [];
    bucket = parsed.pathname.slice(1, slash);
    key = parsed.pathname.slice(slash);
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) return [];
  } else {
    return [];
  }
  if (key.length <= 1) return [];
  const query = parsed.search;
  const addresses = [
    `https://s3.${region}.amazonaws.com/${bucket}${key}${query}`,
    `https://s3.dualstack.${region}.amazonaws.com/${bucket}${key}${query}`,
  ];
  if (!bucket.includes('.')) {
    addresses.push(
      `https://${bucket}.s3.${region}.amazonaws.com${key}${query}`,
      `https://${bucket}.s3.dualstack.${region}.amazonaws.com${key}${query}`,
    );
  }
  const own = parsed.href;
  return addresses.filter(address => new URL(address).href !== own);
}
