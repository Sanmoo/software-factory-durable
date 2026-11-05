export interface Diagnostic {
  id: string;
  status: 'ok' | 'blocked' | 'unverified';
  message: string;
  nextStep: string;
}
