import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT || 8787),
  databaseUrl: process.env.DATABASE_URL || '',
  drive: {
    root: process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID || '1WeOYbhqlO2UNjjqCMW1gT0cU6yFxPDkN',
    folders: {
      JPG: process.env.GOOGLE_DRIVE_JPG_FOLDER_ID || '1H9FBBWyG9QG9RgMxvLzSoQ_IhoKvmrHC',
      PNG: process.env.GOOGLE_DRIVE_PNG_FOLDER_ID || '1hAA3b5y-kuOOGT7EekbRrvrhDfkp2V-e',
      GIF: process.env.GOOGLE_DRIVE_GIF_FOLDER_ID || '1AWyiDMRH1hN2Gy_I1GE50hQ4ta2g9-ol',
      WEBP: process.env.GOOGLE_DRIVE_WEBP_FOLDER_ID || '1DbfRm7xPOckcvGlCj36SMcFJzKnau3zd',
      VIDEO: process.env.GOOGLE_DRIVE_VIDEO_FOLDER_ID || '1qzaqbrIY4FI_AFlOQs_UuWRPg2s8Nyj9',
      THUMBNAILS: process.env.GOOGLE_DRIVE_THUMBNAILS_FOLDER_ID || '1sAJSF3RAIS5casCitpo59-0fV-CWF1wu'
    }
  }
};
