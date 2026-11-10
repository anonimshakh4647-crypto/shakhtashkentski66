<?php
/*
 * KLUB HISOBI — server qismi (PHP).
 * Bu fayl klub-hisob.html bilan BIR PAPKAGA yuklanadi. Ma'lumot shu papkada klub-data.php faylida saqlanadi.
 *
 * 1) Pastdagi $KEY ni o'zingizning maxfiy parolingizga almashtiring (admin kaliti).
 * 2) Papkaga yozish huquqi (chmod 755/775) bo'lishi kerak.
 */
$KEY = 'KLUB-ADMIN-PAROL-NI-ALMASHTIRING';

$DIR  = __DIR__;
$FILE = $DIR . '/klub-data.php';
$GUARD = "<?php http_response_code(404); exit; ?>\n"; // fayl brauzerdan ochilib ketmasligi uchun

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Content-Type, X-Key');
header('Access-Control-Allow-Methods: GET, PUT, POST, OPTIONS');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }

function out($code, $arr) { http_response_code($code); echo json_encode($arr, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES); exit; }
function nowms() { return (int) round(microtime(true) * 1000); }
function keyok() { global $KEY; $k = isset($_SERVER['HTTP_X_KEY']) ? $_SERVER['HTTP_X_KEY'] : ''; if ($KEY === '' || $KEY === 'KLUB-ADMIN-PAROL-NI-ALMASHTIRING') out(500, ['ok' => false, 'err' => 'Avval klub-api.php dagi $KEY ni o\'zingizning parolingizga almashtiring']); return hash_equals($KEY, $k); }
function readdoc() {
    global $FILE, $GUARD;
    if (!is_file($FILE)) return ['rev' => 0, 'data' => null];
    $raw = file_get_contents($FILE); if ($raw === false) return ['rev' => 0, 'data' => null];
    $j = json_decode(substr($raw, strlen($GUARD))); // obyekt sifatida o'qiladi: bo'sh {} bo'sh [] ga aylanib ketmasin
    return is_object($j) && isset($j->rev) ? ['rev' => (int) $j->rev, 'data' => isset($j->data) ? $j->data : null] : ['rev' => 0, 'data' => null];
}

$m = $_SERVER['REQUEST_METHOD'];
if ($m === 'GET') {
    if (isset($_GET['auth'])) { if (keyok()) out(200, ['ok' => true, 'now' => nowms()]); out(403, ['ok' => false, 'err' => 'kalit noto\'g\'ri']); }
    $doc = readdoc();
    if (isset($_GET['rev']) && (int) $_GET['rev'] === (int) $doc['rev'] && $doc['rev'] > 0) out(200, ['rev' => $doc['rev'], 'now' => nowms(), 'same' => true]);
    out(200, ['rev' => $doc['rev'], 'now' => nowms(), 'data' => $doc['data']]);
}
if ($m === 'PUT' || $m === 'POST') {
    if (!keyok()) out(403, ['ok' => false, 'err' => 'kalit noto\'g\'ri']);
    $body = file_get_contents('php://input');
    if (strlen($body) > 8 * 1024 * 1024) out(413, ['ok' => false, 'err' => 'juda katta']);
    $in = json_decode($body);
    if (!is_object($in) || !isset($in->data) || !is_object($in->data)) out(400, ['ok' => false, 'err' => 'noto\'g\'ri so\'rov']);
    $fp = fopen($DIR . '/klub-data.lock', 'c'); if (!$fp) out(500, ['ok' => false, 'err' => 'papkaga yozib bo\'lmadi']);
    flock($fp, LOCK_EX);
    $doc = readdoc(); $base = isset($in->rev) ? (int) $in->rev : 0;
    if ($doc['rev'] > 0 && $base !== (int) $doc['rev'] && empty($in->force)) { flock($fp, LOCK_UN); fclose($fp); out(409, ['ok' => false, 'rev' => $doc['rev'], 'now' => nowms(), 'data' => $doc['data']]); }
    $new = ['rev' => (int) $doc['rev'] + 1, 'saved' => nowms(), 'data' => $in->data];
    if (is_file($FILE)) @copy($FILE, $DIR . '/klub-data.bak.php'); // oxirgi zaxira
    $tmp = $FILE . '.tmp';
    if (file_put_contents($tmp, $GUARD . json_encode($new, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)) === false || !rename($tmp, $FILE)) { flock($fp, LOCK_UN); fclose($fp); out(500, ['ok' => false, 'err' => 'saqlab bo\'lmadi (papka huquqi?)']); }
    flock($fp, LOCK_UN); fclose($fp);
    out(200, ['ok' => true, 'rev' => $new['rev'], 'now' => nowms()]);
}
out(405, ['ok' => false, 'err' => 'usul qo\'llanmaydi']);
