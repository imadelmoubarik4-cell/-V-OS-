#!/usr/bin/env python3
"""Build the S33 release candidate from verified original sources plus reviewed fixes."""
import hashlib, json, shutil, sys, tempfile
from pathlib import Path
from build_isolated_runtime import build, ROOT

def release(destination):
    destination=Path(destination).absolute()
    if destination.exists() or destination.is_symlink() or destination.resolve().is_relative_to(ROOT.resolve()):
        raise ValueError('New destination outside the repository required')
    with tempfile.TemporaryDirectory() as temp:
        original=Path(temp)/'original'; build(original)
        shifts=original/'functions/atlas-shifts/index.ts'
        text=shifts.read_text()
        old='''    if (!refreshWeek) {
      const rawWeek = body.current_week || url.searchParams.get("week_start");
      refreshWeek = requireMonday(rawWeek, "Current week");
    }

'''
        anchor='''    let refreshMonth = body.current_month ? requireMonthStart(body.current_month, "Current month") : null;
'''
        if text.count(old)!=1 or text.count(anchor)!=1: raise ValueError('Shifts patch no longer matches reviewed source')
        text=text.replace(old,'').replace(anchor,anchor+'''    // Validate response context before any write can commit.
    if (!refreshMonth && !refreshWeek) {
      refreshWeek = requireMonday(body.current_week || url.searchParams.get("week_start"), "Current week");
    }
''')
        shifts.write_text(text)
        shutil.copytree(ROOT/'supabase/s33/functions/atlas-import-worker',original/'functions/atlas-import-worker')
        config=original/'config.toml'
        config.write_text(config.read_text()+'\n[functions.atlas-import-worker]\nverify_jwt = false\n')
        files={str(p.relative_to(original)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted((original/'functions').rglob('*')) if p.is_file()}
        manifest={'target':'https://atialqebqxcquzdkezln.supabase.co','gateway_count':17,'hosted_execution_authorized':False,'fixes':['Validate Shifts calendar context before writes'],'files':files,'config_sha256':hashlib.sha256(config.read_bytes()).hexdigest()}
        (original/'release-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
        shutil.copytree(original,destination)
    return manifest
if __name__=='__main__': print(json.dumps(release(sys.argv[1])))
