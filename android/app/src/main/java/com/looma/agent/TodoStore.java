package com.looma.agent;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;
import java.util.Map;

/** The native database, not WebView memory, is the Android todo truth source. */
public final class TodoStore extends SQLiteOpenHelper {
    public static final Object LOCK = new Object();
    private static TodoStore instance;

    public static TodoStore get(Context context) {
        synchronized (LOCK) {
            if (instance == null) instance = new TodoStore(context.getApplicationContext());
            return instance;
        }
    }

    private TodoStore(Context context) { super(context, "looma-todos.db", null, 1); }

    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE todos (space TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(space,id))");
        db.execSQL("CREATE TABLE todo_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    }

    @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        if (oldVersion > newVersion) {
            throw new IllegalStateException("不支持待办数据库降级: v" + oldVersion + " -> v" + newVersion);
        }
        db.beginTransaction();
        try {
            if (oldVersion < 1) {
                onCreate(db);
            }
            // Subsequent schema versions must apply non-destructive incremental ALTER statements here.
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    public static boolean validSpace(String value) { return "life".equals(value) || "work".equals(value); }

    public static JSONObject validateTodo(JSONObject todo) throws JSONException {
        if (todo == null) throw new IllegalArgumentException("待办记录缺失");
        Map<String, Object> values = new HashMap<>();
        Iterator<String> keys = todo.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            values.put(key, todo.get(key));
        }
        TodoRules.validateRecord(values);
        return new JSONObject(todo.toString());
    }

    public JSONArray list(String space) throws JSONException {
        synchronized (LOCK) {
            if (space != null && !validSpace(space)) throw new IllegalArgumentException("无效待办空间");
            JSONArray result = new JSONArray();
            try (Cursor cursor = getReadableDatabase().query("todos", new String[]{"payload"},
                    space == null ? null : "space=?", space == null ? null : new String[]{space}, null, null, "space,id")) {
                while (cursor.moveToNext()) result.put(new JSONObject(cursor.getString(0)));
            }
            return result;
        }
    }

    public JSONObject find(String space, String id) throws JSONException {
        synchronized (LOCK) {
            try (Cursor cursor = getReadableDatabase().query("todos", new String[]{"payload"},
                    "space=? AND id=?", new String[]{space, id}, null, null, null)) {
                return cursor.moveToFirst() ? new JSONObject(cursor.getString(0)) : null;
            }
        }
    }

    private void write(SQLiteDatabase db, JSONObject todo) throws JSONException {
        ContentValues values = new ContentValues();
        values.put("space", todo.getString("space"));
        values.put("id", todo.getString("id"));
        values.put("payload", todo.toString());
        if (db.insertWithOnConflict("todos", null, values, SQLiteDatabase.CONFLICT_REPLACE) == -1)
            throw new IllegalStateException("待办写入失败");
    }

    public JSONObject put(JSONObject input, Object expectedRevision) throws JSONException {
        synchronized (LOCK) {
            JSONObject todo = validateTodo(input);
            Long expected = null;
            if (expectedRevision != JSONObject.NULL) {
                expected = TodoRules.integer(expectedRevision, "expectedRevision", 1);
            }
            SQLiteDatabase db = getWritableDatabase();
            db.beginTransaction();
            try {
                JSONObject current = find(todo.getString("space"), todo.getString("id"));
                TodoRules.checkRevision(current == null ? null : current.getLong("revision"), expected, todo.getLong("revision"));
                write(db, todo);
                db.setTransactionSuccessful();
            } finally { db.endTransaction(); }
            return todo;
        }
    }

    public void replaceAll(JSONArray input) throws JSONException {
        synchronized (LOCK) {
            if (input == null) throw new IllegalArgumentException("待办集合缺失");
            JSONArray validated = new JSONArray();
            Set<String> ids = new HashSet<>();
            for (int i = 0; i < input.length(); i++) {
                JSONObject todo = validateTodo(input.getJSONObject(i));
                String identity = todo.getString("space") + "\u0000" + todo.getString("id");
                if (!ids.add(identity)) throw new IllegalArgumentException("待办记录重复");
                validated.put(todo);
            }
            SQLiteDatabase db = getWritableDatabase();
            db.beginTransaction();
            try {
                db.delete("todos", null, null);
                for (int i = 0; i < validated.length(); i++) write(db, validated.getJSONObject(i));
                db.setTransactionSuccessful();
            } finally { db.endTransaction(); }
        }
    }

    /** Delivery metadata belongs to the current revision; it is not a user mutation. */
    public void markNotified(JSONObject todo, long now) throws JSONException {
        synchronized (LOCK) {
            JSONObject latest = find(todo.getString("space"), todo.getString("id"));
            if (latest == null || latest.getLong("revision") != todo.getLong("revision")) return;
            latest.put("notifiedRevision", latest.getLong("revision"));
            latest.put("lastNotifiedAt", now);
            write(getWritableDatabase(), latest);
        }
    }

    public boolean enabled() {
        synchronized (LOCK) {
            try (Cursor cursor = getReadableDatabase().rawQuery("SELECT value FROM todo_settings WHERE key='enabled'", null)) {
                return cursor.moveToFirst() && "true".equals(cursor.getString(0));
            }
        }
    }

    public void setEnabled(boolean enabled) {
        synchronized (LOCK) {
            ContentValues values = new ContentValues();
            values.put("key", "enabled");
            values.put("value", enabled ? "true" : "false");
            if (getWritableDatabase().insertWithOnConflict("todo_settings", null, values, SQLiteDatabase.CONFLICT_REPLACE) == -1)
                throw new IllegalStateException("待办设置写入失败");
        }
    }
}
