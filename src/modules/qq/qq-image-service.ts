/**
 * @description QQ 图片服务，下载图片 URL 到本地并返回文件路径
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-05-01 23:58
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { AppError } from "../../lib/errors";

type QqImageServiceDeps = {
  fetchImpl?: typeof fetch;
  imageStoreRoot?: string;
};

const DEFAULT_IMAGE_STORE_ROOT = resolve(process.cwd(), "data", "qq-images");

export class QqImageService {
  private readonly fetchImpl: typeof fetch;
  private readonly imageStoreRoot: string;

  constructor(private readonly deps: QqImageServiceDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.imageStoreRoot = deps.imageStoreRoot ?? DEFAULT_IMAGE_STORE_ROOT;
  }

  async downloadImageByUrl(input: {
    imageUrl: string;
    messageId?: string | null;
  }) {
    const imageUrl = String(input.imageUrl || "").trim();
    if (!imageUrl) {
      throw new AppError("QQ_IMAGE_URL_MISSING", 400, "QQ image url is required");
    }

    const response = await this.fetchImpl(imageUrl, {
      method: "GET"
    });
    if (!response.ok) {
      const responseText = await response.text().catch(() => "");
      throw new AppError(
        "QQ_IMAGE_DOWNLOAD_FAILED",
        502,
        `Failed to download QQ image: status=${response.status} body=${responseText || "<empty>"}`
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    const extension = this.resolveExtension(contentType, imageUrl);
    const savedPath = this.resolveStoragePath({
      imageUrl,
      messageId: input.messageId ?? null,
      extension
    });

    mkdirSync(dirname(savedPath), { recursive: true });
    writeFileSync(savedPath, Buffer.from(arrayBuffer));
    return {
      imageUrl,
      savedPath
    };
  }

  private resolveStoragePath(input: {
    imageUrl: string;
    messageId: string | null;
    extension: string;
  }) {
    const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const messageToken = (input.messageId || "msg").replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 48) || "msg";
    const urlToken = input.imageUrl.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 64) || "image";
    const fileName = `${Date.now()}_${messageToken}_${urlToken}${input.extension}`;
    return resolve(this.imageStoreRoot, day, fileName);
  }

  private resolveExtension(contentType: string, imageUrl: string) {
    if (contentType.includes("image/png")) {
      return ".png";
    }
    if (contentType.includes("image/jpeg") || contentType.includes("image/jpg")) {
      return ".jpg";
    }
    if (contentType.includes("image/webp")) {
      return ".webp";
    }
    if (contentType.includes("image/gif")) {
      return ".gif";
    }
    if (contentType.includes("image/bmp")) {
      return ".bmp";
    }

    const matched = imageUrl.match(/\.([a-zA-Z0-9]{2,6})(?:\?|#|$)/);
    if (matched) {
      return `.${matched[1].toLowerCase()}`;
    }
    return ".bin";
  }
}
