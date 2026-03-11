import type { AgentCommSignedIdentityArtifactBundle } from "./artifact-workflow";
import { buildIdentityArtifactBundleShareUrl } from "./card-packaging";
import QRCode from "qrcode";

const CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum",
  10: "Optimism",
  56: "BNB Chain",
  137: "Polygon",
  196: "X Layer",
  8453: "Base",
  42161: "Arbitrum",
  43114: "Avalanche",
};

function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-2)}`;
}

function chainLabel(chainId: number): string {
  const name = CHAIN_NAMES[chainId];
  return name ? `${name} (${chainId})` : `Chain ${chainId}`;
}

export async function generateCardHtml(bundle: AgentCommSignedIdentityArtifactBundle): Promise<string> {
  const card = bundle.contactCard;
  const displayName = card.displayName || "Agent";
  const identity = shortenAddress(card.identityWallet);
  const chain = chainLabel(card.transport.chainId);
  const capabilities = card.defaults?.capabilities ?? [];
  const shareUrl = buildIdentityArtifactBundleShareUrl(bundle);
  const bundleJson = JSON.stringify(bundle);

  // Generate QR code as data URL server-side
  const qrDataUrl = await QRCode.toDataURL(shareUrl, {
    errorCorrectionLevel: "L",
    width: 400,
    margin: 4,
    color: { dark: "#000000", light: "#ffffff" },
  });

  const capTags = capabilities
    .map((c: string) => `<span class="cap-tag">${escapeHtml(c)}</span>`)
    .join("\n    ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Agent Card — ${escapeHtml(displayName)}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#050508;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#e8e8e8}
.card{width:420px;background:linear-gradient(145deg,#0f0f14 0%,#0a0a0e 100%);border:1px solid rgba(255,77,77,0.15);border-radius:20px;padding:40px 36px;position:relative;overflow:hidden;box-shadow:0 0 60px rgba(255,77,77,0.06),0 20px 40px rgba(0,0,0,0.4)}
.card::before{content:'';position:absolute;top:-50%;right:-50%;width:100%;height:100%;background:radial-gradient(circle,rgba(255,77,77,0.04) 0%,transparent 70%);pointer-events:none}
.header{display:flex;align-items:center;gap:16px;margin-bottom:32px}
.lobster-icon{width:48px;height:48px;flex-shrink:0}
.header-text{flex:1}
.agent-name{font-size:22px;font-weight:700;letter-spacing:-0.3px;color:#fff}
.protocol-badge{display:inline-block;margin-top:4px;font-size:11px;font-weight:600;color:rgba(255,77,77,0.9);background:rgba(255,77,77,0.08);border:1px solid rgba(255,77,77,0.15);border-radius:6px;padding:2px 8px;letter-spacing:0.5px}
.divider{height:1px;background:linear-gradient(90deg,transparent,rgba(255,77,77,0.2),transparent);margin:0 0 24px}
.info-row{display:flex;align-items:center;gap:8px;margin-bottom:12px;font-size:13px;color:rgba(255,255,255,0.5)}
.info-row .label{color:rgba(255,255,255,0.3);min-width:52px}
.info-row .value{color:rgba(255,255,255,0.8);font-family:'SF Mono',SFMono-Regular,Consolas,monospace;font-size:12.5px}
.info-row .chain-dot{width:6px;height:6px;border-radius:50%;background:#22c55e;display:inline-block;margin-right:4px}
.capabilities{display:flex;flex-wrap:wrap;gap:8px;margin:20px 0 28px}
.cap-tag{font-size:12px;font-weight:500;color:rgba(255,255,255,0.7);background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:5px 12px;letter-spacing:0.2px}
.qr-section{display:flex;align-items:center;gap:20px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.05);border-radius:14px;padding:20px}
.qr-box{width:120px;height:120px;background:#fff;border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0;overflow:hidden}
.qr-box img{width:160px;height:160px;border-radius:6px}
.qr-text{flex:1}
.qr-title{font-size:13px;font-weight:600;color:rgba(255,255,255,0.8);margin-bottom:6px}
.qr-desc{font-size:11.5px;color:rgba(255,255,255,0.35);line-height:1.5}
.qr-copy{margin-top:10px;font-size:11px;font-weight:600;color:rgba(255,77,77,0.8);background:rgba(255,77,77,0.06);border:1px solid rgba(255,77,77,0.12);border-radius:6px;padding:5px 12px;cursor:pointer;transition:all 0.2s;border-style:solid}
.qr-copy:hover{background:rgba(255,77,77,0.12);color:rgba(255,77,77,1)}
.footer{margin-top:28px;display:flex;align-items:center;justify-content:space-between}
.footer-brand{display:flex;align-items:center;gap:6px;font-size:11px;color:rgba(255,255,255,0.2);letter-spacing:0.3px}
.footer-brand svg{width:14px;height:14px;opacity:0.4}
.footer-powered{font-size:10px;color:rgba(255,255,255,0.12);letter-spacing:0.5px;text-transform:uppercase}
</style>
</head>
<body>
<div class="card">
  <div class="header">
    <svg class="lobster-icon" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="lg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#ff4d4d"/><stop offset="100%" stop-color="#991b1b"/></linearGradient></defs>
      <path d="M60 10 C30 10 15 35 15 55 C15 75 30 95 45 100 L45 110 L55 110 L55 100 C55 100 60 102 65 100 L65 110 L75 110 L75 100 C90 95 105 75 105 55 C105 35 90 10 60 10Z" fill="url(#lg)"/>
      <path d="M20 45 C5 40 0 50 5 60 C10 70 20 65 25 55 C28 48 25 45 20 45Z" fill="url(#lg)"/>
      <path d="M100 45 C115 40 120 50 115 60 C110 70 100 65 95 55 C92 48 95 45 100 45Z" fill="url(#lg)"/>
      <path d="M45 15 Q35 5 30 8" stroke="#ff4d4d" stroke-width="3" stroke-linecap="round"/>
      <path d="M75 15 Q85 5 90 8" stroke="#ff4d4d" stroke-width="3" stroke-linecap="round"/>
      <circle cx="45" cy="35" r="6" fill="#050810"/><circle cx="75" cy="35" r="6" fill="#050810"/>
      <circle cx="46" cy="34" r="2.5" fill="#00e5cc"/><circle cx="76" cy="34" r="2.5" fill="#00e5cc"/>
    </svg>
    <div class="header-text">
      <div class="agent-name">${escapeHtml(displayName)}</div>
      <span class="protocol-badge">AGENT-COMM v2</span>
    </div>
  </div>
  <div class="divider"></div>
  <div class="info-row">
    <span class="label">Identity</span>
    <span class="value">${identity}</span>
  </div>
  <div class="info-row">
    <span class="label">Chain</span>
    <span class="value"><span class="chain-dot"></span>${escapeHtml(chain)}</span>
  </div>
  ${capabilities.length > 0 ? `<div class="capabilities">\n    ${capTags}\n  </div>` : ""}
  <div class="qr-section">
    <div class="qr-box"><img id="qr" src="${qrDataUrl}" alt="QR Code" style="width:160px;height:160px;image-rendering:pixelated;border-radius:6px"/></div>
    <div class="qr-text">
      <div class="qr-title">Scan to Connect</div>
      <div class="qr-desc">Import this card and send a connection request. The agent owner will review and approve.</div>
      <button class="qr-copy" onclick="copyUrl()">Copy Import URL</button>
    </div>
  </div>
  <div class="footer">
    <div class="footer-brand">
      <svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M60 10 C30 10 15 35 15 55 C15 75 30 95 45 100 L45 110 L55 110 L55 100 C55 100 60 102 65 100 L65 110 L75 110 L75 100 C90 95 105 75 105 55 C105 35 90 10 60 10Z" fill="currentColor"/>
        <path d="M20 45 C5 40 0 50 5 60 C10 70 20 65 25 55 C28 48 25 45 20 45Z" fill="currentColor"/>
        <path d="M100 45 C115 40 120 50 115 60 C110 70 100 65 95 55 C92 48 95 45 100 45Z" fill="currentColor"/>
      </svg>
      Agent-Comm · OpenClaw
    </div>
    <div class="footer-powered">Blockchain-Native E2E Encrypted</div>
  </div>
</div>
<script>
var SHARE_URL=${JSON.stringify(shareUrl)};
function copyUrl(){navigator.clipboard.writeText(SHARE_URL).then(function(){var b=document.querySelector('.qr-copy');b.textContent='Copied!';setTimeout(function(){b.textContent='Copy Import URL'},1500)})}
</script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
