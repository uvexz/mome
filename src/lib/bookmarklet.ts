const TITLE_LIMIT = 500
const TEXT_LIMIT = 5000
const URL_LIMIT = 2000

export function buildCaptureBookmarklet(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('bookmarklet origin must use HTTP or HTTPS')
  }

  const origin = JSON.stringify(url.origin)
  return `javascript:(()=>{const u=new URL(${origin}+"/capture");const s=String(getSelection()||"").trim().slice(0,${TEXT_LIMIT});u.searchParams.set("title",document.title.slice(0,${TITLE_LIMIT}));if(s)u.searchParams.set("text",s);u.searchParams.set("url",location.href.slice(0,${URL_LIMIT}));u.searchParams.set("tag","收藏");const w=open(u.toString(),"_blank");if(w)w.opener=null;else location.href=u.toString()})()`
}
