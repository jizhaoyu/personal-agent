package com.looma.agent;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * 基于 AndroidKeyStore 硬件安全模块 (TEE/StrongBox) 的 AES-256-GCM 凭据加密封箱，
 * 作用等价于桌面端 Windows DPAPI，确保 API Key 从不以明文落盘。
 */
public final class KeyStoreVault {
    private static final String KEYSTORE_PROVIDER = "AndroidKeyStore";
    private static final String KEY_ALIAS = "looma_master_credential_key_v1";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private static final String PREF_NAME = "looma_secure_vault";

    private final SharedPreferences prefs;

    public KeyStoreVault(Context context) {
        this.prefs = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
    }

    private SecretKey getOrCreateSecretKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER);
        keyStore.load(null);
        if (keyStore.containsAlias(KEY_ALIAS)) {
            KeyStore.SecretKeyEntry entry = (KeyStore.SecretKeyEntry) keyStore.getEntry(KEY_ALIAS, null);
            return entry.getSecretKey();
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE_PROVIDER);
        KeyGenParameterSpec spec = new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build();
        generator.init(spec);
        return generator.generateKey();
    }

    public void saveConnection(String apiBaseUrl, String modelName, String apiKey, boolean enabled) throws Exception {
        SharedPreferences.Editor editor = prefs.edit()
                .putString("apiBaseUrl", apiBaseUrl)
                .putString("modelName", modelName)
                .putBoolean("enabled", enabled);

        if (apiKey != null && !apiKey.trim().isEmpty()) {
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateSecretKey());
            byte[] iv = cipher.getIV();
            byte[] encrypted = cipher.doFinal(apiKey.trim().getBytes(StandardCharsets.UTF_8));
            editor.putString("apiKey_iv", Base64.encodeToString(iv, Base64.NO_WRAP));
            editor.putString("apiKey_cipher", Base64.encodeToString(encrypted, Base64.NO_WRAP));
        }
        editor.apply();
    }

    public String readApiKey() {
        try {
            String ivB64 = prefs.getString("apiKey_iv", null);
            String cipherB64 = prefs.getString("apiKey_cipher", null);
            if (ivB64 == null || cipherB64 == null) return "";
            byte[] iv = Base64.decode(ivB64, Base64.NO_WRAP);
            byte[] encrypted = Base64.decode(cipherB64, Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateSecretKey(), new GCMParameterSpec(128, iv));
            return new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return "";
        }
    }

    public boolean hasApiKey() {
        return prefs.contains("apiKey_cipher") && prefs.contains("apiKey_iv");
    }

    public String getApiBaseUrl() {
        return prefs.getString("apiBaseUrl", "https://api.deepseek.com/v1");
    }

    public String getModelName() {
        return prefs.getString("modelName", "deepseek-chat");
    }

    public boolean isEnabled() {
        return prefs.getBoolean("enabled", false);
    }

    public void clear() {
        prefs.edit().clear().apply();
    }
}
