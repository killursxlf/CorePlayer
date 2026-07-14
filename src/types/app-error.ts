export type AppError = {
  code: string
  title: string
  message: string
  technicalDetails?: string
  recoverable: boolean
}

export function createAppError(error: AppError): AppError {
  return error
}
