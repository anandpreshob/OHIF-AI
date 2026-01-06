// multipart.ts
// Optional fallback (uncomment the import and the line in gunzip() if you install pako):
// import { ungzip as pakoUngzip } from "pako";

function uint8ToString(u8: Uint8Array): string {
    return new TextDecoder("utf-8").decode(u8);
  }

/**
 * Parse NIfTI-1 format and extract voxel data
 * NIfTI header is 348 bytes, voxel data starts at vox_offset (typically 352)
 *
 * IMPORTANT: Server returns dims as [Z, Y, X] but client expects [X, Y, Z] slice-by-slice
 * This function transposes the data to match client expectations.
 */
export function parseNifti(data: Uint8Array): { voxels: Uint8Array; dims: number[]; datatype: number } {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // Check if this looks like a NIfTI file
  // sizeof_hdr should be 348 for NIfTI-1
  const sizeof_hdr = view.getInt32(0, true); // little-endian

  if (sizeof_hdr !== 348) {
    // Not a NIfTI file, return as-is (raw voxels)
    console.debug('Not a NIfTI file (sizeof_hdr:', sizeof_hdr, '), treating as raw voxels');
    return { voxels: data, dims: [], datatype: 0 };
  }

  // Read dimensions (dim array at offset 40)
  const ndim = view.getInt16(40, true);
  const dims: number[] = [];
  for (let i = 0; i < Math.min(ndim, 7); i++) {
    dims.push(view.getInt16(42 + i * 2, true));
  }

  // Read datatype at offset 70
  const datatype = view.getInt16(70, true);

  // Read vox_offset at offset 108 (float32)
  const vox_offset = view.getFloat32(108, true);

  console.debug('NIfTI header: dims=', dims, 'datatype=', datatype, 'vox_offset=', vox_offset);

  // Extract voxel data starting at vox_offset
  const voxelStart = Math.max(Math.ceil(vox_offset), 352); // At least 352 for .nii format
  let voxels = data.slice(voxelStart);

  console.debug('Extracted voxels: offset=', voxelStart, 'length=', voxels.length);

  // Server returns data in [Z, Y, X] order (Z varies fastest)
  // Client expects [X, Y, Z] order (slice-by-slice, X varies fastest)
  // We need to transpose from [Z, Y, X] to [X, Y, Z]
  if (dims.length >= 3) {
    const [dimZ, dimY, dimX] = dims;  // Server's [Z=43, Y=512, X=512]
    const sliceSize = dimX * dimY;    // 512 * 512 = 262144 per slice

    console.debug(`Transposing NIfTI data from [${dimZ}, ${dimY}, ${dimX}] to [${dimX}, ${dimY}, ${dimZ}]`);

    // Create output array for transposed data
    const transposed = new Uint8Array(voxels.length);

    // Transpose: input[z + dimZ * (y + dimY * x)] -> output[x + dimX * (y + dimY * z)]
    // Or equivalently: for each output slice z, gather pixels from input
    for (let z = 0; z < dimZ; z++) {
      for (let y = 0; y < dimY; y++) {
        for (let x = 0; x < dimX; x++) {
          // Input index: z varies fastest, then y, then x
          const srcIdx = z + dimZ * (y + dimY * x);
          // Output index: x varies fastest, then y, then z (slice-by-slice)
          const dstIdx = x + dimX * (y + dimY * z);
          transposed[dstIdx] = voxels[srcIdx];
        }
      }
    }

    voxels = transposed;
    console.debug('Transposed voxels to slice-by-slice format');
  }

  return { voxels, dims, datatype };
}
  
  function findCRLFCRLF(u8: Uint8Array): number {
    for (let i = 0; i + 3 < u8.length; i++) {
      if (u8[i] === 13 && u8[i + 1] === 10 && u8[i + 2] === 13 && u8[i + 3] === 10) return i;
    }
    return -1;
  }
  
  function parseHeaders(headerStr: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of headerStr.split(/\r?\n/)) {
      const idx = line.indexOf(":");
      if (idx > -1) out[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
    return out;
  }
  
  function getBoundary(ct: string | null): string {
    if (!ct) throw new Error("Missing Content-Type");
    const m = /boundary=([^;]+)/i.exec(ct);
    if (!m) throw new Error("No boundary in Content-Type");
    return m[1].replace(/^"(.*)"$/, "$1"); // handle quoted boundary
  }
  
  async function gunzip(buf: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const DS: any = (globalThis as any).DecompressionStream;
    if (typeof DS === "function") {
      const ds = new DS("gzip");
      const stream = new Blob([u8]).stream().pipeThrough(ds);
      const ab = await new Response(stream).arrayBuffer();
      return new Uint8Array(ab);
    }
    // Fallback: use pako if you installed it
    // return pakoUngzip(u8);
    // If no fallback is available, throw to avoid silent JSON.parse errors:
    throw new Error("Gzip content received but no DecompressionStream (install pako for fallback).");
  }
  
  async function gunzipIfNeeded(u8: Uint8Array, headers: Record<string, string>): Promise<Uint8Array> {
    const enc = (headers["content-encoding"] || "").toLowerCase();
    const ctype = (headers["content-type"] || "").toLowerCase();
    // Check both content-encoding and content-type for gzip
    // Server may send Content-Type: application/gzip for .nii.gz files
    if (!enc.includes("gzip") && !ctype.includes("gzip")) return u8;
    return gunzip(u8);
  }
  
  /** If the WHOLE HTTP response is gzipped, decompress it before parsing multipart */
  export async function maybeGunzipWholeResponse(
    bodyBuf: ArrayBuffer,
    responseHeaders: Record<string, string | string[] | undefined>
  ): Promise<ArrayBuffer> {
    const enc = (responseHeaders["content-encoding"] || "").toString().toLowerCase();
    if (!enc.includes("gzip")) return bodyBuf;
    const u8 = new Uint8Array(bodyBuf);
    // If already decompressed by the browser (normal in XHR/fetch), first two bytes won't be 0x1f 0x8b
    const looksGzip = u8.length >= 2 && u8[0] === 0x1f && u8[1] === 0x8b;
    if (!looksGzip) return bodyBuf; // nothing to do
    const unzipped = await gunzip(u8);
    return unzipped.buffer;
  }
  
  /**
   * Parse a multipart/form-data response body.
   * - Accepts already-decompressed ArrayBuffer.
   * - Auto-decompresses per-part gzip for both "meta" (JSON) and "seg" (binary).
   */
  export async function parseMultipart(
    bodyBuf: ArrayBuffer,
    contentType: string
  ): Promise<{ meta: any; seg: Uint8Array }> {
    const boundary = getBoundary(contentType);
    const u8 = new Uint8Array(bodyBuf);
    const boundaryBytes = new TextEncoder().encode(`--${boundary}`);
    const finalBoundaryBytes = new TextEncoder().encode(`--${boundary}--`);
    const nextMarker = new TextEncoder().encode(`\r\n--${boundary}`);
  
    const parts: Uint8Array[] = [];
    let i = 0;
  
    while (i < u8.length) {
      // skip CRLF between parts
      if (u8[i] === 13 && u8[i + 1] === 10) i += 2;
  
      // final boundary?
      if (u8.slice(i, i + finalBoundaryBytes.length).every((b, k) => b === finalBoundaryBytes[k])) break;
  
      // need a boundary
      if (!u8.slice(i, i + boundaryBytes.length).every((b, k) => b === boundaryBytes[k])) {
        i++; // resync
        continue;
      }
  
      // advance past boundary and CRLF
      let j = i + boundaryBytes.length;
      if (u8[j] === 13 && u8[j + 1] === 10) j += 2;
  
      const rest = u8.slice(j);
      const split = findCRLFCRLF(rest);
      if (split < 0) break;
  
      const bodyStart = j + split + 4;
  
      // find end before "\r\n--boundary"
      let k = bodyStart;
      let end = -1;
      for (; k + nextMarker.length <= u8.length; k++) {
        let match = true;
        for (let t = 0; t < nextMarker.length; t++) {
          if (u8[k + t] !== nextMarker[t]) { match = false; break; }
        }
        if (match) { end = k; break; }
      }
      if (end === -1) end = u8.length;
  
      parts.push(u8.slice(j, end)); // headers + CRLFCRLF + body
      i = end + 2; // skip CRLF before next boundary
    }
  
    let metaObj: any = null;
    let seg = new Uint8Array(0);
  
    for (const p of parts) {
      const split = findCRLFCRLF(p);
      if (split < 0) continue;
      const headers = parseHeaders(uint8ToString(p.slice(0, split)));
      let body = p.slice(split + 4);
  
      // Defensive: if someone accidentally placed header lines into the body, peel them.
      const headProbe = uint8ToString(body.slice(0, 16));
      if (/^Content-\w+/i.test(headProbe)) {
        // peel leaked headers block from body
        const leakIdx = findCRLFCRLF(body);
        if (leakIdx > -1) {
          const leakedHeaderStr = uint8ToString(body.slice(0, leakIdx));
          const extra = parseHeaders(leakedHeaderStr);
          Object.assign(headers, extra);
          body = body.slice(leakIdx + 4);
        }
      }
  
      const cd = headers["content-disposition"] || "";
      const m = /name="([^"]+)"/i.exec(cd);
      const name = m ? m[1] : "";

      const ctype = (headers["content-type"] || "").toLowerCase();

      // Accept both "meta" and "params" for JSON metadata (server uses "params")
      if ((name === "meta" || name === "params") && ctype.includes("application/json")) {
        const unzipped = await gunzipIfNeeded(body, headers);
        try {
          metaObj = JSON.parse(uint8ToString(unzipped));
        } catch (e) {
          // Helpful debug: show the first few characters
          const preview = uint8ToString(unzipped.slice(0, 24));
          throw new Error(`Failed to parse meta JSON (starts with: ${JSON.stringify(preview)})`);
        }
      // Accept both "seg" and "image" for binary segmentation data (server uses "image")
      // Also accept application/gzip content type (server sends gzipped NIfTI)
      } else if ((name === "seg" || name === "image") && (ctype.includes("application/octet-stream") || ctype.includes("application/gzip"))) {
        seg = await gunzipIfNeeded(body, headers);
      }
    }

    if (!metaObj) throw new Error("meta part not found (expected name='meta' or name='params' with application/json)");
    if (!seg.length) throw new Error("seg part not found (expected name='seg' or name='image' with octet-stream or gzip)");

    if (typeof metaObj === 'string') {
      metaObj = JSON.parse(metaObj);
    }
  
    return { meta: metaObj, seg };
  }
  