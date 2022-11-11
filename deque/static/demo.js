/*eslint-env browser */
/*global ace, PHP */
/*eslint-disable no-console */
var editor = ace.edit("editor");
editor.setTheme("ace/theme/github");
editor.session.setMode("ace/mode/php");
editor.setShowPrintMargin(false);

var default_code = "<?php\n" + document.getElementById('features_example').innerText;

var query = new URLSearchParams(document.location.search);
var run_button = document.getElementById('run');
var analyze_button = document.getElementById('analyze');
var output_area = document.getElementById('output');
var precomputed_output = document.getElementById('precomputed_output');
var isUsable = false;

var initial_code = query.has('code') ? query.get('code') : '';
if (query.has('code') && initial_code != default_code) {
    editor.setValue(initial_code);
} else {
    editor.setValue(default_code);
    // Pre-render the output of the demo to show the types of issues Phan is capable of detecting.
    output_area.innerHTML = precomputed_output.innerHTML;
}

var phpModule;
var phpModuleDidLoad = false;
var combinedOutput = '';
var combinedHTMLOutput = '';

function getOrDefault(value, defaultValue) {
    return value !== '' ? value : defaultValue;
}

function htmlescape(text) {
    var el = document.createElement('span');
    el.innerText = text;
    return el.innerHTML;
}

/**
 * This wraps generateNewPHPModule.
 *
 * It makes the buttons clickable immediately on subsequent runs,
 * while silently waiting for php to become executable again.
 *
 * @returns {Promise<PHP>}
 */
function lazyGenerateNewPHPModule(cb) {
    cb = cb || function() {}
    if (phpModuleDidLoad) {
        cb();
        return;
    }
    try {
        generateNewPHPModule().then(function (newPHPModule) {
            phpModuleDidLoad = true;
            phpModule = newPHPModule;
            cb();
        }).catch(function(e) {
            showWebAssemblyError("Unexpected error reloading php: " + e.toString())
        });
    } catch (e) {
        showWebAssemblyError("Unexpected error reloading php: " + e.toString())
    }
}

function doRun(code, outputIsHTML, defaultText) {
    output_area.innerHTML = '';
    code = code + "\necho PHP_EOL;" // flush line buffer
    console.log('evaluating code'); // , code);
    let invokePHP = function () {
        combinedOutput = '';
        combinedHTMLOutput = '';
        lazyGenerateNewPHPModule(invokePHPInner);
    };
    let invokePHPInner = function () {
        let ret = phpModule.ccall('pib_eval', 'number', ["string"], [code])
        console.log('done evaluating code', ret);
        if (ret != 0) {
            combinedOutput += "Error, please check your code";
            combinedHTMLOutput += "Error, please check your code";
        }
        if (outputIsHTML && ret == 0) {
            output_area.innerHTML = getOrDefault(combinedHTMLOutput.replace(/\n/g, ""), defaultText);
        } else {
            output_area.innerHTML = getOrDefault(combinedOutput, defaultText);
        }
        // Make sure the output area is rendered, then refresh the php runtime environment
        requestAnimationFrame(function () {
            setTimeout(function () {
                try {
                    phpModule._pib_force_exit();
                } catch (e) {
                    // ExitStatus
                }
                phpModule = null;
                phpModuleDidLoad = false;
                enableButtons();
                isUsable = true;
                console.log('buttons enabled');
                requestAnimationFrame(function () {
                    setTimeout(function () {
                        console.log('render'); lazyGenerateNewPHPModule();
                    }, 0);
                });
            }, 0);
        });
    };
    // This works around an issue seen in firefox where
    // the browser's appearance won't update because JS(emscripten) is still running.
    // This tries to ensure that buttons get hidden properly and output gets cleared.
    requestAnimationFrame(function () {
        setTimeout(invokePHP, 0);
    });
}
function doRunWithWrapper(analysisWrapper, code, outputIsHTML, defaultText) {
    // single quotes aren't escaped by encodeURIComponent, but double quotes are.
    // Other problematic characters are escaped, and this preserves UTF-8.
    var contentsFragment = 'rawurldecode("' + encodeURIComponent(code) + '")';
    var analysisCode = analysisWrapper.replace(/\$CONTENTS_TO_ANALYZE/g, contentsFragment);

    doRun(analysisCode, outputIsHTML, defaultText);
}

var didInit = false;

var buttons = [run_button, analyze_button];

function enableButtons() {
    run_button.textContent = "Run"
    analyze_button.textContent = "Analyze"
    for (var button of buttons) {
        button.disabled = false
        button.classList.remove('disabled')
    }
}

function disableButtons() {
    for (var button of buttons) {
        button.disabled = true
        button.classList.add('disabled')
    }
}

function updateQueryParams(code) {
    var query = new URLSearchParams();
    if (code.length < 1024 && code != default_code) {
        query.append('code', code);
        history.replaceState({}, document.title, "?" + query.toString());
    }
}

// Based on emscripten generated source
function fetchRemotePackage(packageName, callback) {
    var xhr = new XMLHttpRequest;
    xhr.open('GET', packageName, true);
    xhr.responseType = 'arraybuffer';
    xhr.onerror = function (event) {
        console.log('NetworkError for: ' + packageName, event);
        showWebAssemblyError('NetworkError for: ' + packageName);
        throw new Error('NetworkError for: ' + packageName);
    };
    xhr.onload = function (/*event */) {
        console.log('xhr loaded status=' + xhr.status);
        if (xhr.status == 200 || xhr.status == 304 || xhr.status == 206 || xhr.status == 0 && xhr.response) {
            var packageData = xhr.response;
            callback(packageData)
        } else {
            showWebAssemblyError(xhr.statusText + ' : ' + xhr.responseURL);
            throw new Error(xhr.statusText + ' : ' + xhr.responseURL)
        }
    };
    xhr.send(null)
}

/* This can be reused - This avoids notices about HTTP 302s and using the streaming API in some browsers (firefox), but is counterproductive if other browsers (Chrome) would normally just use disk cache. */
var phpWasmBinary = null;
function loadPhpWasm(cb) {
    console.log('called loadPhpWasm');
    if (phpWasmBinary) {
        cb(phpWasmBinary);
        return;
    }
    fetchRemotePackage('php.wasm', function (data) {
        phpWasmBinary = data;
        cb(phpWasmBinary);
    });
}

function init() {
    if (didInit) {
        return;
    }
    didInit = true;
    // This is a monospace element without HTML.
    // output_area.innerText = "Click ANALYZE";
    enableButtons();

    run_button.addEventListener('click', function () {
        if (!isUsable) {
            console.log('skipping due to already running');
            return;
        }
        isUsable = false;
        output_area.innerText = '';
        run_button.textContent = "Running"
        disableButtons();
        var code = editor.getValue();
        updateQueryParams(code);
        var analysisWrapper = document.getElementById('eval_wrapper_source').innerText;
        code = "?>" + code;
        doRunWithWrapper(analysisWrapper, code, false, 'PHP code ran successfully with no output.');
    });
    analyze_button.addEventListener('click', function () {
        if (!isUsable) {
            console.log('skipping due to already running');
            return;
        }
        isUsable = false;
        output_area.innerText = '';
        analyze_button.textContent = "Analyzing"
        disableButtons();
        var code = editor.getValue();
        updateQueryParams(code);
        var analysisWrapper = document.getElementById('phan_runner_source').innerText;
        doRunWithWrapper(analysisWrapper, code, true, 'Phan did not detect any errors.');
    });
}

var sizeInBytes = 134217728;
var WASM_PAGE_SIZE = 65536;
var reusableWasmMemory;

/**
 * @param {Function} callback callback to call after the script runs
 * @returns {Promise<PHP>} the new php module
 */
function generateNewPHPModule() {
    fillReusableMemoryWithZeroes();
    reusableWasmMemory = reusableWasmMemory || new WebAssembly.Memory({
        initial: sizeInBytes / WASM_PAGE_SIZE,
        maximum: sizeInBytes / WASM_PAGE_SIZE,
    });
    var phpModuleOptions = {
        // postRun: [callback],
        onAbort: function(what) {
            markButtonsAsUnusable();
            var errorElement = document.createElement('p');
            errorElement.setAttribute('class', 'phan_issuetype_critical');
            errorElement.innerText = 'WebAssembly aborted: ' + what.toString();
            output_area.appendChild(errorElement);
        },
        print: function (text) {
            console.log('print', arguments);

            if (arguments.length > 1) {
                text = Array.prototype.slice.call(arguments).join(' ');
            }
            if (didInit && phpModuleDidLoad) {
                combinedOutput += htmlescape(text) + "\n";
                combinedHTMLOutput += text + "\n";
            }
        },
        printErr: function (text) {
            console.log('printErr', arguments);

            if (arguments.length > 1) {
                text = Array.prototype.slice.call(arguments).join(' ');
            }
            if (text == '') {
                return;
            }
            if (didInit && phpModuleDidLoad) {
                combinedHTMLOutput += '<span class="stderr">' + text + "</span>\n";
                combinedOutput += '<span class="stderr">' + htmlescape(text) + "</span>\n";
            }
        },
        wasmBinary: phpWasmBinary,
        wasmMemory: reusableWasmMemory,
    };
    console.log('creating PHP module fetchPreloadedPackage override');
    return PHP(phpModuleOptions).then(function (newPHPModule) {
        console.log('created PHP module', newPHPModule);
        return newPHPModule;
    }).catch(function (error) {
        showWebAssemblyError('Failed to initialize WebAssembly module: ' + error.message);
        throw error;
    });
}

/** This fills the wasm memory with 0s, so that the next fresh program startup succeeds */
function fillReusableMemoryWithZeroes() {
    if (reusableWasmMemory) {
        var arr = new Uint8Array(reusableWasmMemory.buffer);
        arr.fill(0);
    }
}
function markButtonsAsUnusable() {
    run_button.innerText = "ERROR";
    run_button.removeAttribute('title');
    analyze_button.innerText = "ERROR";
    analyze_button.removeAttribute('title');
    disableButtons();
    isUsable = false;
}
function showWebAssemblyError(message) {
    output_area.setAttribute('style', 'font-family: serif');
    output_area.innerHTML =
        '<h1 class="phan_issuetype_critical">' + message + '</h1>';
    markButtonsAsUnusable();
}
if (!window.WebAssembly) {
    showWebAssemblyError('Your browser does not support WebAssembly.');
} else if (!window.PHP) {
    showWebAssemblyError('Failed to load php.js.');
} else {
    console.log('downloading php.wasm');
    loadPhpWasm(function () {
        console.log('successfully downloaded php.wasm to reuse');
        /** This fills the wasm memory with 0s, so that the next fresh program startup succeeds */
        generateNewPHPModule().then(function (newPHPModule) {
            console.log('successfully initialized php module');
            phpModule = newPHPModule
            isUsable = true;
            init();
        }).catch(function (error) {
            showWebAssemblyError('Failed to initialize WebAssembly module: ' + error.message);
        });
    });
}
