/**
 * The other addresses of one public Amazon S3 object.
 *
 * S3 answers every object at several host names: virtual-hosted
 * (`<bucket>.s3.<region>.amazonaws.com/<key>`), path-style
 * (`s3.<region>.amazonaws.com/<bucket>/<key>`), both again on the
 * dual-stack endpoint (`s3.dualstack.<region>.amazonaws.com`) and on the
 * region's dashed endpoint (`s3-<region>.amazonaws.com`, which the Regions
 * older than 2019 keep), and virtual-hosted on the global endpoint
 * (`<bucket>.s3.amazonaws.com`). Each answers with the same bytes, the same
 * `ETag` and the same CORS headers (measured on the CELLxGENE Census bucket
 * in us-west-2: seven hosts, one `ETag`, `Access-Control-Allow-Origin: *`
 * from each; the global endpoint path-style answers 301, so it is not one).
 * A Region without a dashed endpoint does not resolve it: that mirror fails
 * twice and is dropped (`mirrors.js`), its requests asked of the file's own
 * address. S3 speaks only HTTP/1.1, and a browser keeps
 * six connections to one host, so a file read through many small requests (a
 * chunk index's nodes, a cell-major matrix's row pointers) waits on six round
 * trips at a time. Spread over the object's addresses, its requests run on six
 * connections to each (`httpByteSource` mirrors).
 *
 * Only an unsigned URL has other addresses: a signed one (`X-Amz-Signature`,
 * a pre-signed link) signs its host. A bucket whose name holds a dot has no
 * virtual-hosted HTTPS address its certificate covers, so it keeps its own.
 *
 * Object stores also differ from a web host in what they say of an object
 * that does not exist (`bucketHidesMissing`).
 *
 * @module formats/io/s3
 */

/** `<bucket>.s3.<region>.amazonaws.com`, `<bucket>.s3.dualstack.<region>.amazonaws.com`. */
const VIRTUAL_HOSTED = /^([a-z0-9][a-z0-9-]{1,61}[a-z0-9])\.s3(?:\.dualstack)?\.([a-z0-9-]+)\.amazonaws\.com$/;
/** `s3.<region>.amazonaws.com`, `s3.dualstack.<region>.amazonaws.com`. */
const PATH_STYLE = /^s3(?:\.dualstack)?\.([a-z0-9-]+)\.amazonaws\.com$/;
/** Any S3 endpoint: regional, dual-stack, the global one and the dashed `s3-<region>` ones, virtual-hosted or path-style. */
const ANY_S3_HOST = /(^|\.)s3(?:[.-][a-z0-9-]+)*\.amazonaws\.com$/;
/** Google Cloud Storage's XML API, path-style or virtual-hosted. */
const GCS_HOST = /(^|\.)storage\.googleapis\.com$/;
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
    `https://s3-${region}.amazonaws.com/${bucket}${key}${query}`,
  ];
  if (!bucket.includes('.')) {
    addresses.push(
      `https://${bucket}.s3.${region}.amazonaws.com${key}${query}`,
      `https://${bucket}.s3.dualstack.${region}.amazonaws.com${key}${query}`,
      `https://${bucket}.s3-${region}.amazonaws.com${key}${query}`,
      `https://${bucket}.s3.amazonaws.com${key}${query}`,
    );
  }
  const own = parsed.href;
  return addresses.filter(address => new URL(address).href !== own);
}

/**
 * Whether `url` names an object of an Amazon S3 or Google Cloud Storage
 * bucket. Both answer **403**, not 404, for an object that does not exist
 * when the reader may not list the bucket (S3: `s3:ListBucket`; GCS:
 * `storage.objects.list`), as for every public bucket that allows reading
 * objects only. A Zarr writer leaves out every chunk that holds only the
 * fill value (zarr-python's default), so on such a bucket a 403 for a chunk
 * of a store whose metadata the same bucket has served is that chunk being
 * absent (`zarr/stores/http.js`). A bucket the reader may not read at all
 * refuses the metadata first, so no permission error is taken for an
 * absent object.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function bucketHidesMissing(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  const host = parsed.hostname.toLowerCase();
  return ANY_S3_HOST.test(host) || GCS_HOST.test(host);
}
