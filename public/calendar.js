// Simple month calendar renderer
(function(){
  function parseISO(iso){ try { return new Date(iso); } catch { return new Date(); } }
  function startOfMonth(d){ return new Date(d.getFullYear(), d.getMonth(), 1); }
  function endOfMonth(d){ return new Date(d.getFullYear(), d.getMonth()+1, 0); }
  function addMonths(d, n){ return new Date(d.getFullYear(), d.getMonth()+n, 1); }
  function formatMonthYear(d){ return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }); }
  function sameDay(a,b){ return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate(); }

  var state = {
    current: startOfMonth(new Date()),
    appts: []
  };

  function loadAppointments(){
    var el = document.getElementById('appointments-json');
    if(!el) return [];
    try { return JSON.parse(el.textContent||'[]'); } catch { return []; }
  }

  function groupByDay(appts){
    var map = new Map();
    appts.forEach(function(a){
      if (String(a.status||'confirmed') !== 'confirmed') return; // hide canceled
      var d = new Date((a.start_ts||0)*1000);
      var key = d.getFullYear()+"-"+(d.getMonth()+1)+"-"+d.getDate();
      if(!map.has(key)) map.set(key, []);
      map.get(key).push(a);
    });
    return map;
  }

  function extractName(apt){
    if (apt && apt.summary) return String(apt.summary);
    var notes = String(apt.notes||'');
    if(notes){
      var parts = notes.split('|');
      for(var i=0;i<parts.length;i++){
        var p = parts[i].trim();
        var colon = p.indexOf(':');
        if(colon > -1){
          var key = p.slice(0, colon).trim().toLowerCase();
          var val = p.slice(colon+1).trim();
          if(/name/.test(key) && val) return val;
        }
      }
      // fallback: take first pair's value if present
      var first = parts[0]||''; var idx = first.indexOf(':');
      if(idx > -1){
        var v = first.slice(idx+1).trim();
        if(v) return v;
      }
    }
    // as a safer fallback, show phone or a generic label instead of echoing the message text
    return String(apt.contact_phone||'Booking');
  }

  function render(){
    var root = document.getElementById('calendarRoot');
    if(!root) return;
    root.innerHTML = '';

    var toolbar = document.createElement('div');
    toolbar.className = 'calendar-';
    var left = document.createElement('button'); left.className='btn-ghost'; left.textContent='‹'; left.onclick=function(){ state.current = addMonths(state.current, -1); render(); };
    var right = document.createElement('button'); right.className='btn-ghost'; right.textContent='›'; right.onclick=function(){ state.current = addMonths(state.current, 1); render(); };
    var title = document.createElement('div'); title.className='calendar-title'; title.textContent = formatMonthYear(state.current);
    var legend = document.createElement('div'); legend.className='calendar-legend'; legend.innerHTML = '<span class="swatch swatch-blue"></span> Appointments';
    var leftWrap = document.createElement('div'); leftWrap.style.display='flex'; leftWrap.style.gap='8px'; leftWrap.appendChild(left); leftWrap.appendChild(right);
    var rightWrap = document.createElement('div'); rightWrap.appendChild(legend);
    toolbar.appendChild(title); toolbar.appendChild(leftWrap); toolbar.appendChild(rightWrap);

    var cal = document.createElement('div'); cal.className='calendar';
    var grid = document.createElement('div'); grid.className='calendar-grid';

    var days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    days.forEach(function(d){ var h=document.createElement('div'); h.className='calendar-dow'; h.textContent=d; grid.appendChild(h); });

    var first = startOfMonth(state.current);
    var last = endOfMonth(state.current);
    var startIdx = first.getDay();
    var totalDays = last.getDate();

    var apptMap = groupByDay(state.appts);

    // Fill 6 weeks (42 cells)
    for(var i=0;i<42;i++){
      var cell = document.createElement('div'); cell.className='calendar-cell';
      var date = new Date(first); date.setDate(1 - startIdx + i);
      if(date.getMonth() !== state.current.getMonth()) cell.classList.add('other-month');
      var day = document.createElement('div'); day.className='day'; day.textContent=String(date.getDate());
      var list = document.createElement('div'); list.className='calendar-events';
      var key = date.getFullYear()+"-"+(date.getMonth()+1)+"-"+date.getDate();
      var items = apptMap.get(key) || [];
      items.sort(function(a,b){ return a.start_ts - b.start_ts; });
      items.forEach(function(a){
        var ev = document.createElement('div'); ev.className='cal-event';
        ev.textContent = extractName(a);
        list.appendChild(ev);
      });
      cell.appendChild(day); cell.appendChild(list);

      // Click to open modal with all appointments for the day
      if(items.length > 0){
        cell.style.cursor = 'pointer';
        (function(dateCopy, itemsCopy){
          cell.addEventListener('click', function(){ showDayModal(dateCopy, itemsCopy); });
        })(new Date(date), items.slice());
      }
      grid.appendChild(cell);
    }

    cal.appendChild(grid);

    var wrap = document.createElement('div');
    wrap.className = 'card calendar-card';
    wrap.appendChild(toolbar);
    wrap.appendChild(cal);
    root.appendChild(wrap);
  }

  function showDayModal(date, appointments){
    var existing = document.getElementById('dayModal');
    if(existing) existing.remove();

    var modal = document.createElement('div');
    modal.id = 'dayModal';
    modal.className = 'day-modal';

    var overlay = document.createElement('div');
    overlay.className = 'day-modal-overlay';
    overlay.onclick = function(){ modal.remove(); };

    var content = document.createElement('div');
    content.className = 'day-modal-content';

    var header = document.createElement('div');
    header.className = 'day-modal-header';
    header.innerHTML = '<h3>'+ date.toLocaleDateString(undefined, { weekday:'long', year:'numeric', month:'long', day:'numeric' }) +'</h3>'+
      '<button class="day-modal-close" onclick="document.getElementById(\'dayModal\').remove()">×</button>';

    var body = document.createElement('div');
    body.className = 'day-modal-body';

    if(!appointments || !appointments.length){
      body.innerHTML = '<p class="day-modal-empty">No appointments for this day</p>';
    } else {
      var list = document.createElement('div');
      list.className = 'day-modal-list';
      // sort by start time
      appointments.sort(function(a,b){ return a.start_ts - b.start_ts; });
      appointments.forEach(function(apt){
        var item = document.createElement('div');
        item.className = 'day-modal-item';
        var start = new Date((apt.start_ts||0)*1000).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
        var end = new Date((apt.end_ts||0)*1000).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
        var name = extractName(apt);
        var phone = apt.contact_phone || '';
        var staff = apt.staff_name || '';
        var notes = apt.notes || '';
        var idVal = (apt.id != null ? apt.id : (apt._id_str || apt._id));
        if (apt && apt.source === 'google') {
          var link = apt.html_link ? (' <a href="'+apt.html_link+'" target="_blank" rel="noopener">Open in Google</a>') : '';
          item.innerHTML =
            '<div class="day-modal-time">'+ start +' - '+ end +'</div>'+
            '<div class="day-modal-name">'+ name +' <span style="color:#6b7280;">(Google Calendar)</span></div>'+
            (staff ? '<div class="day-modal-staff">Organizer: '+ staff +'</div>' : '')+
            (link ? '<div class="day-modal-link">'+ link +'</div>' : '');
        } else {
          item.innerHTML =
            '<div class="day-modal-time">'+ start +' - '+ end +'</div>'+
            '<div class="day-modal-name">'+ name +'</div>'+
            (phone ? '<div class="day-modal-phone">'+ phone +'</div>' : '')+
            (staff ? '<div class="day-modal-staff">Staff: '+ staff +'</div>' : '')+
            '<div class="day-modal-notes"><label style="display:block;margin:6px 0 4px;">Notes</label><textarea data-notes-for="'+idVal+'" rows="3" style="width:100%;box-sizing:border-box;">'+ (notes||'') +'</textarea></div>'+
            '<div class="day-modal-actions" style="display:flex;gap:8px;margin-top:8px;">'+
              '<button class="btn" data-act="save_notes" data-id="'+idVal+'">Save Notes</button>'+
              '<button class="btn btn-danger" data-act="cancel" data-id="'+idVal+'">Cancel</button>'+
              '<button class="btn" data-act="reschedule" data-id="'+idVal+'">Reschedule</button>'+
            '</div>';
        }
        list.appendChild(item);
      });
      body.appendChild(list);
    }

    content.appendChild(header);
    content.appendChild(body);
    modal.appendChild(overlay);
    modal.appendChild(content);
    document.body.appendChild(modal);
    // trigger fade-in
    requestAnimationFrame(function(){ modal.classList.add('show'); });

    // Wire actions
    content.addEventListener('click', function(e){
      var t = e.target;
      if(!t || !t.getAttribute) return;
      var act = t.getAttribute('data-act');
      if(!act) return;
      var id = t.getAttribute('data-id');
      if(!id) return;
      if(act === 'save_notes'){
        var ta = content.querySelector('textarea[data-notes-for="'+id+'"]');
        var notes = ta ? ta.value : '';
        try { console.log('[Calendar][Notes] PATCH start', { id, notes_len: (notes||'').length }); } catch(e){}
        fetch('/booking/'+id+'/notes', { method:'PATCH', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ notes: notes }) })
          .then(function(r){ try { console.log('[Calendar][Notes] response', r.status); } catch(e){} return r.json(); })
          .then(function(){ ta.style.outline='2px solid #22c55e'; setTimeout(function(){ ta.style.outline=''; }, 800); })
          .catch(function(err){ try { console.warn('[Calendar][Notes] error', err); } catch(e){} });
      } else if (act === 'cancel'){
        if(!confirm('Cancel this booking?')) return;
        try { console.log('[Calendar][Cancel] DELETE start', { id }); } catch(e){}
        fetch('/booking/'+id, { method:'DELETE' })
          .then(function(r){ try { console.log('[Calendar][Cancel] response status', r.status); } catch(e){} return r.json().catch(function(){ return { ok:false, error:'invalid response'}; }).then(function(j){ return { ok:r.ok, status:r.status, body:j }; }); })
          .then(function(resp){ try { console.log('[Calendar][Cancel] response body', resp); } catch(e){}
            if(!resp.ok || resp.body.ok === false){ alert('Failed to cancel booking'+ (resp.body && resp.body.error ? (': '+resp.body.error) : '')); return; }
            // mark as canceled and close modal
            state.appts = state.appts.map(function(a){ var aid = String(a.id!=null?a.id:(a._id_str||a._id)); if(String(aid)===String(id)){ a.status='canceled'; } return a; });
            try { console.log('[Calendar][Cancel] local state updated; closing modal'); } catch(e){}
            render();
            var m = document.getElementById('dayModal'); if (m) m.remove();
          })
          .catch(function(err){ try { console.warn('[Calendar][Cancel] error', err); } catch(e){} });
      } else if (act === 'reschedule'){
        var durationMs = 0;
        var ap = (state.appts || []).find(function(a){ var aid = String(a.id!=null?a.id:(a._id_str||a._id)); return String(aid)===String(id); });
        if (ap) durationMs = Math.max(30*60*1000, (ap.end_ts - ap.start_ts) * 1000);
        var newStart = prompt('Enter new start (YYYY-MM-DDTHH:MM local)', new Date().toISOString().slice(0,16));
        if(!newStart) return;
        var s = new Date(newStart);
        if(isNaN(s.getTime())){ alert('Invalid date/time'); return; }
        var e = new Date(s.getTime() + durationMs);
        try { console.log('[Calendar][Reschedule] PUT start', { id, start: s.toISOString(), end: e.toISOString() }); } catch(e){}
        fetch('/booking/'+id, { method:'PUT', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ start: s.toISOString(), end: e.toISOString() }) })
          .then(function(r){ try { console.log('[Calendar][Reschedule] response', r.status); } catch(e){} return r.json(); })
          .then(function(){
            // update local appt times and cancel others handled server-side
            state.appts = state.appts.map(function(a){ var aid = String(a.id!=null?a.id:(a._id_str||a._id)); if(String(aid)===String(id)){ a.start_ts=Math.floor(s.getTime()/1000); a.end_ts=Math.floor(e.getTime()/1000); a.status='confirmed'; } return a; });
            render(); showDayModal(date, state.appts.filter(function(a){ return sameDay(new Date(a.start_ts*1000), date); }));
          })
          .catch(function(err){ try { console.warn('[Calendar][Reschedule] error', err); } catch(e){} });
      }
    });
  }

  function init(){
    var mount = document.getElementById('calendarRoot');
    if(!mount) return;
    state.appts = loadAppointments();
    render();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
