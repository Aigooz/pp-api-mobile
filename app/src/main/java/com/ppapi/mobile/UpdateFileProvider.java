package com.ppapi.mobile;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.Environment;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;

/**
 * Exposes exactly one file - the downloaded update APK - to the system
 * installer. A minimal provider keeps the app free of a support-library
 * dependency while still granting a readable content:// URI.
 */
public final class UpdateFileProvider extends ContentProvider {
    static final String AUTHORITY_SUFFIX = ".updates";

    static Uri uriFor(Context context) {
        return new Uri.Builder().scheme("content")
                .authority(context.getPackageName() + AUTHORITY_SUFFIX)
                .appendPath(UpdateClient.ASSET_NAME).build();
    }

    @Override public boolean onCreate() { return true; }

    private File target() { return MainActivity.updateFile(getContext()); }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws java.io.FileNotFoundException {
        File file = target();
        if (file == null || !file.isFile()) throw new java.io.FileNotFoundException("安装包不存在");
        if (!UpdateClient.ASSET_NAME.equals(uri.getLastPathSegment())) throw new java.io.FileNotFoundException("未知文件");
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        File file = target();
        if (file == null || !file.isFile()) return null;
        String[] columns = projection != null ? projection
                : new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE};
        MatrixCursor cursor = new MatrixCursor(columns, 1);
        Object[] row = new Object[columns.length];
        for (int i = 0; i < columns.length; i++) {
            if (OpenableColumns.SIZE.equals(columns[i])) row[i] = file.length();
            else row[i] = file.getName();
        }
        cursor.addRow(row);
        return cursor;
    }

    @Override public String getType(Uri uri) { return "application/vnd.android.package-archive"; }

    @Override public Uri insert(Uri uri, ContentValues values) { return null; }

    @Override public int delete(Uri uri, String selection, String[] selectionArgs) { return 0; }

    @Override public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) { return 0; }
}
