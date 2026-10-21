import { _electron as electron, type ElectronApplication } from '@playwright/test';
import { resolve } from 'node:path';

export async function launch(data: string, developmentUrl = ''): Promise<ElectronApplication> {
  return electron.launch({
    ...(process.env.INTERVIEW_DESKTOP_EXECUTABLE
      ? { executablePath: process.env.INTERVIEW_DESKTOP_EXECUTABLE }
      : {}),
    args: [
      ...(process.env.INTERVIEW_DESKTOP_EXECUTABLE ? [] : [resolve('.')]),
      ...(process.platform === 'linux' ? ['--ozone-platform=x11'] : []),
    ],
    env: {
      ...process.env,
      INTERVIEW_DESKTOP_DATA_DIR: data,
      INTERVIEW_DESKTOP_PROBLEMS_DIR: '',
      INTERVIEW_DESKTOP_DEV_URL: developmentUrl,
    },
    timeout: 30_000,
  });
}
