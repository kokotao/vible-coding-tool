export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(code: string, statusCode: number, message: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
  }
}
