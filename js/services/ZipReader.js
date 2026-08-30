/**
 * 轻量 ZIP 读取器（纯浏览器原生实现，无外部依赖）
 * 支持Stored(0)/Deflate(8)两种压缩方式，基于 DecompressionStream('deflate-raw')
 * 文件名优先 UTF-8 解码，失败时回退 GBK（兼容中文压缩包）
 * @module services/ZipReader
 */

const EOCD_SIGNATURE = 0x06054b50;
const CEN_SIGNATURE = 0x02014b50;
const LOC_SIGNATURE = 0x04034b50;
const EOCD_MIN_LEN = 22;
const EOCD_SCAN_MAX = 65535 + EOCD_MIN_LEN;

function decodeZipName(bytes) {
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  try {
    return utf8.decode(bytes);
  } catch {
    try {
      return new TextDecoder('gbk').decode(bytes);
    } catch {
      return new TextDecoder('utf-8').decode(bytes);
    }
  }
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * 解析 zip 字节流，返回条目数组
 * @param {ArrayBuffer} buffer
 * @returns {Promise<Array<{name: string, bytes: Uint8Array}>>}
 */
export async function readZip(buffer) {
  const view = new DataView(buffer);
  const total = view.byteLength;

  // 从尾部向前查找 EOCD
  let eocd = -1;
  for (let i = total - EOCD_MIN_LEN; i >= Math.max(0, total - EOCD_SCAN_MAX); i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error('无效的 ZIP 文件：未找到目录结束标记');
  }

  const entries = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);

  const files = [];
  for (let i = 0; i < entries; i += 1) {
    if (offset + 46 > total || view.getUint32(offset, true) !== CEN_SIGNATURE) {
      throw new Error('无效的 ZIP 文件：目录结构损坏');
    }
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);

    const nameBytes = new Uint8Array(buffer, offset + 46, nameLen);
    const name = decodeZipName(nameBytes);

    // 目录项（以 / 结尾）跳过
    if (!name.endsWith('/')) {
      // 读本地文件头定位数据区
      if (localOffset + 30 > total || view.getUint32(localOffset, true) !== LOC_SIGNATURE) {
        throw new Error(`无效的 ZIP 文件：条目 ${name} 本地头损坏`);
      }
      const localNameLen = view.getUint16(localOffset + 26, true);
      const localExtraLen = view.getUint16(localOffset + 28, true);
      const dataOffset = localOffset + 30 + localNameLen + localExtraLen;
      const raw = new Uint8Array(buffer, dataOffset, compressedSize);

      if (method === 0) {
        files.push({ name, bytes: raw });
      } else if (method === 8) {
        files.push({ name, bytes: await inflateRaw(raw) });
      } else {
        throw new Error(`ZIP 条目 ${name} 使用不支持的压缩方式（${method}）`);
      }
    }

    offset += 46 + nameLen + extraLen + commentLen;
  }

  return files;
}
