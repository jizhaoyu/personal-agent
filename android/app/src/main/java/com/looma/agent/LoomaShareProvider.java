package com.looma.agent;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.util.List;
import java.util.Locale;

/**
 * Read-only ContentProvider serving temporary exported PNG/text artifacts from internal cache
 * without requiring external storage permissions.
 */
public final class LoomaShareProvider extends ContentProvider {
    public static final String AUTHORITY = "com.looma.agent.shareprovider";
    public static final String SHARED_DIR_NAME = "shared_exports";

    @Override
    public boolean onCreate() {
        return true;
    }

    private File resolveSafeFile(Uri uri) throws FileNotFoundException {
        Context context = getContext();
        if (context == null || uri == null) {
            throw new FileNotFoundException("Provider context or URI missing");
        }
        String authority = uri.getAuthority();
        String expectedAuthority = context.getPackageName() + ".shareprovider";
        if (authority != null && !AUTHORITY.equals(authority) && !expectedAuthority.equals(authority)) {
            throw new SecurityException("Untrusted authority");
        }
        List<String> segments = uri.getPathSegments();
        if (segments == null || segments.size() != 1) {
            throw new SecurityException("Invalid shared path");
        }
        String fileName = segments.get(0);
        if (fileName == null || fileName.isEmpty() || ".".equals(fileName) || "..".equals(fileName)
                || fileName.contains("/") || fileName.contains("\\") || fileName.indexOf('\0') >= 0) {
            throw new SecurityException("Invalid shared filename");
        }
        try {
            File sharedDir = new File(context.getCacheDir(), SHARED_DIR_NAME);
            String baseCanonical = sharedDir.getCanonicalPath();
            File target = new File(sharedDir, fileName);
            String targetCanonical = target.getCanonicalPath();
            String requiredPrefix = baseCanonical.endsWith(File.separator)
                    ? baseCanonical
                    : baseCanonical + File.separator;
            if (!targetCanonical.startsWith(requiredPrefix)) {
                throw new SecurityException("Path traversal blocked");
            }
            if (!target.exists() || !target.isFile()) {
                throw new FileNotFoundException("Shared file not found");
            }
            return target;
        } catch (SecurityException | FileNotFoundException e) {
            throw e;
        } catch (IOException e) {
            throw new FileNotFoundException("Unable to canonicalize shared file");
        }
    }

    private static String inferMimeType(String fileName) {
        String lower = fileName != null ? fileName.toLowerCase(Locale.US) : "";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".txt")) return "text/plain";
        if (lower.endsWith(".json") || lower.endsWith(".jsonl")) return "application/json";
        return "application/octet-stream";
    }

    @Override
    public String getType(Uri uri) {
        try {
            File file = resolveSafeFile(uri);
            return inferMimeType(file.getName());
        } catch (Exception ignored) {
            return null;
        }
    }

    @Override
    public String[] getStreamTypes(Uri uri, String mimeTypeFilter) {
        String mime = getType(uri);
        if (mime == null) return null;
        if (mimeTypeFilter == null || "*/*".equals(mimeTypeFilter)
                || mimeTypeFilter.equals(mime)
                || (mimeTypeFilter.endsWith("/*") && mime.startsWith(mimeTypeFilter.substring(0, mimeTypeFilter.length() - 1)))) {
            return new String[]{mime};
        }
        return null;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (mode == null) {
            throw new SecurityException("Missing open mode");
        }
        int parsedMode;
        try {
            parsedMode = ParcelFileDescriptor.parseMode(mode);
        } catch (IllegalArgumentException e) {
            throw new SecurityException("Invalid open mode");
        }
        if (parsedMode != ParcelFileDescriptor.MODE_READ_ONLY) {
            throw new SecurityException("LoomaShareProvider is strictly read-only");
        }
        File file = resolveSafeFile(uri);
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        File file;
        try {
            file = resolveSafeFile(uri);
        } catch (FileNotFoundException e) {
            return null;
        }
        String[] cols = (projection != null && projection.length > 0)
                ? projection
                : new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE};
        String[] resultCols = new String[cols.length];
        Object[] resultValues = new Object[cols.length];
        for (int i = 0; i < cols.length; i++) {
            String col = cols[i];
            resultCols[i] = col;
            if (OpenableColumns.DISPLAY_NAME.equals(col)) {
                resultValues[i] = file.getName();
            } else if (OpenableColumns.SIZE.equals(col)) {
                resultValues[i] = file.length();
            } else {
                resultValues[i] = null;
            }
        }
        MatrixCursor cursor = new MatrixCursor(resultCols, 1);
        cursor.addRow(resultValues);
        return cursor;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        throw new UnsupportedOperationException("Read-only provider");
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException("Read-only provider");
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException("Read-only provider");
    }
}
