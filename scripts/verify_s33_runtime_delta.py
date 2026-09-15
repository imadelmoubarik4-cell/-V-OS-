#!/usr/bin/env python3
"""Verify the frozen runtime delta against its explicit statement audit."""
import hashlib, json, re
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]

def verify():
    audit=json.loads((ROOT/'supabase/s33/runtime-delta-audit.json').read_text())
    path=ROOT/audit['migration']; data=path.read_bytes()
    assert hashlib.sha256(data).hexdigest()==audit['sha256'],'Runtime migration changed without audit'
    text=data.decode()
    assert not any(x in text for x in ('dnefgcmjcgxlynycxkts','uhbamqetppqmygesoeeh','cwazoxupbwxnixpmmlhx'))
    chunks=re.split(r'^-- SOURCE (supabase/migrations/[^\n]+) statement (\d+)\n',text,flags=re.M)
    expected=[x for x in audit['statements'] if x['action']=='include']
    assert len(chunks)==1+3*len(expected)
    for i,entry in enumerate(expected):
        source,index,body=chunks[1+3*i:4+3*i]
        if i==len(expected)-1: body=body.split('-- Neutral isolated settings:')[0]
        assert source==entry['path'] and int(index)==entry['statement']
        assert hashlib.sha256(body.rstrip().encode()).hexdigest()==entry['output_sha256'],source
    return {'migration':audit['migration'],'sha256':audit['sha256'],'included_statements':len(expected),
            'omitted_statements':sum(x['action']=='omit' for x in audit['statements']),
            'excluded_files':len(audit['excluded_files'])}
if __name__=='__main__': print(json.dumps(verify()))
