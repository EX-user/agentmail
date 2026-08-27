package online.mailofagents.twa;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * v0.6.29 (superior repro 01M11HND): androidbrowserhelper's stock
 * WebViewFallbackActivity does not implement onShowFileChooser, so
 * <input type=file> was silently dead on ROMs that take the WebView
 * fallback path. This custom fallback activity provides a WebView with a
 * full-featured WebChromeClient (file chooser bridged to ACTION_GET_CONTENT).
 *
 * Declared in AndroidManifest.xml replacing the stock WebViewFallbackActivity
 * (same intent-filter / meta-data so bubblewrap config keeps working).
 */
public class WebViewFallbackActivity extends Activity {

    private static final int FILE_CHOOSER_REQUEST = 1001;

    private WebView mWebView;
    private ValueCallback<Uri[]> mFilePathCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        mWebView = new WebView(this);
        WebSettings s = mWebView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        mWebView.setWebViewClient(new WebViewClient());
        mWebView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (mFilePathCallback != null) {
                    mFilePathCallback.onReceiveValue(null);
                }
                mFilePathCallback = callback;
                try {
                    Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("*/*");
                    startActivityForResult(Intent.createChooser(intent, null), FILE_CHOOSER_REQUEST);
                    return true;
                } catch (android.content.ActivityNotFoundException e) {
                    mFilePathCallback = null;
                    return false;
                }
            }
        });
        setContentView(mWebView);

        String url = getIntent().getDataString();
        if (url == null) url = "https://mailofagents.online/";
        if (savedInstanceState != null) {
            mWebView.restoreState(savedInstanceState);
        } else {
            mWebView.loadUrl(url);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != FILE_CHOOSER_REQUEST) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        Uri[] results = null;
        if (resultCode == Activity.RESULT_OK && data != null && data.getData() != null) {
            results = new Uri[]{ data.getData() };
        }
        if (mFilePathCallback != null) {
            mFilePathCallback.onReceiveValue(results);
            mFilePathCallback = null;
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        mWebView.saveState(outState);
    }

    @Override
    public void onBackPressed() {
        if (mWebView != null && mWebView.canGoBack()) {
            mWebView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
