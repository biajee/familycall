// Google Ads tag (gtag.js), rendered inside <head> on every page. The
// snippet is Google's verbatim; the account id is the only local value.
const GOOGLE_ADS_ID = "AW-18467187973";

export function GoogleTag() {
  return (
    <>
      {/* Google tag (gtag.js) */}
      <script async src={`https://www.googletagmanager.com/gtag/js?id=${GOOGLE_ADS_ID}`} />
      <script
        dangerouslySetInnerHTML={{
          __html: `
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());

  gtag('config', '${GOOGLE_ADS_ID}');
`,
        }}
      />
    </>
  );
}
