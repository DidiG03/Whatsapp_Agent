(function(){
  function parseISO(iso){ try { return new Date(iso); } catch { return new Date(); } }
  function startOfMonth(d){ return new Date(d.getFullYear(), d.getMonth(), 1); }
  function endOfMonth(d){ return new Date(d.getFullYear(), d.getMonth()+1, 0); }
  function addMonths(d, n){ return new Date(d.getFullYear(), d.getMonth()+n, 1); }
  function formatMonthYear(d){ return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }); }
  function sameDay(a,b){ return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate(); }
  function formatTime(ts){
    return new Date((ts || 0) * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  function isToday(date){ return sameDay(date, new Date()); }

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
      if (String(a.status||'confirmed') !== 'confirmed') return;
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
      var first = parts[0]||''; var idx = first.indexOf(':');
      if(idx > -1){
        var v = first.slice(idx+1).trim();
        if(v) return v;
      }
    }
    return String(apt.contact_phone||'Booking');
  }

  function confirmedCount(appts){
    return (appts || []).filter(function(a){ return String(a.status||'confirmed') === 'confirmed'; }).length;
  }

  function createNavButton(label, onClick){
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'calendar-nav-btn';
    btn.setAttribute('aria-label', label);
    btn.textContent = label;
    btn.onclick = onClick;
    return btn;
  }

  function render(){
    var root = document.getElementById('calendarRoot');
    if(!root) return;
    root.innerHTML = '';

    var wrap = document.createElement('div');
    wrap.className = 'bookings-calendar';

    var toolbar = document.createElement('div');
    toolbar.className = 'calendar-toolbar';

    var navGroup = document.createElement('div');
    navGroup.className = 'calendar-toolbar__left';
    navGroup.appendChild(createNavButton('‹', function(){ state.current = addMonths(state.current, -1); render(); }));

    var title = document.createElement('h2');
    title.className = 'calendar-title';
    title.textContent = formatMonthYear(state.current);
    navGroup.appendChild(title);

    navGroup.appendChild(createNavButton('›', function(){ state.current = addMonths(state.current, 1); render(); }));

    var todayBtn = document.createElement('button');
    todayBtn.type = 'button';
    todayBtn.className = 'calendar-today-btn';
    todayBtn.textContent = 'Today';
    todayBtn.onclick = function(){ state.current = startOfMonth(new Date()); render(); };
    navGroup.appendChild(todayBtn);

    var meta = document.createElement('div');
    meta.className = 'calendar-toolbar__right';
    meta.innerHTML =
      '<span class="calendar-stat"><strong>'+ confirmedCount(state.appts) +'</strong> upcoming</span>' +
      '<span class="calendar-legend"><span class="swatch swatch-blue"></span>Appointments</span>';

    toolbar.appendChild(navGroup);
    toolbar.appendChild(meta);

    var body = document.createElement('div');
    body.className = 'calendar-body';

    var grid = document.createElement('div');
    grid.className = 'calendar-grid';

    var days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    days.forEach(function(d){
      var h = document.createElement('div');
      h.className = 'calendar-dow';
      h.textContent = d;
      grid.appendChild(h);
    });

    var first = startOfMonth(state.current);
    var startIdx = first.getDay();
    var apptMap = groupByDay(state.appts);

    for(var i=0;i<42;i++){
      var cell = document.createElement('div');
      cell.className = 'calendar-cell';
      var date = new Date(first);
      date.setDate(1 - startIdx + i);

      if(date.getMonth() !== state.current.getMonth()) cell.classList.add('other-month');
      if(isToday(date)) cell.classList.add('is-today');

      var day = document.createElement('div');
      day.className = 'calendar-day-num';
      if(isToday(date)) day.classList.add('is-today');
      day.textContent = String(date.getDate());

      var list = document.createElement('div');
      list.className = 'calendar-events';
      var key = date.getFullYear()+"-"+(date.getMonth()+1)+"-"+date.getDate();
      var items = apptMap.get(key) || [];
      items.sort(function(a,b){ return a.start_ts - b.start_ts; });

      if(items.length > 0) cell.classList.add('has-events');

      items.slice(0, 3).forEach(function(a){
        var ev = document.createElement('div');
        ev.className = 'cal-event';
        ev.title = extractName(a) + ' · ' + formatTime(a.start_ts);
        ev.innerHTML =
          '<span class="cal-event__time">'+ formatTime(a.start_ts) +'</span>' +
          '<span class="cal-event__name">'+ extractName(a) +'</span>';
        list.appendChild(ev);
      });

      if(items.length > 3){
        var more = document.createElement('div');
        more.className = 'calendar-more';
        more.textContent = '+' + (items.length - 3) + ' more';
        list.appendChild(more);
      }

      cell.appendChild(day);
      cell.appendChild(list);

      if(items.length > 0){
        cell.style.cursor = 'pointer';
        (function(dateCopy, itemsCopy){
          cell.addEventListener('click', function(){ showDayModal(dateCopy, itemsCopy); });
        })(new Date(date), items.slice());
      }

      grid.appendChild(cell);
    }

    body.appendChild(grid);
    wrap.appendChild(toolbar);
    wrap.appendChild(body);
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
    requestAnimationFrame(function(){ modal.classList.add('show'); });
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
        fetch('/booking/'+id+'/notes', { method:'PATCH', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ notes: notes }) })
          .then(function(r){ return r.json(); })
          .then(function(){ ta.style.outline='2px solid #22c55e'; setTimeout(function(){ ta.style.outline=''; }, 800); })
          .catch(function(){});
      } else if (act === 'cancel'){
        if(!confirm('Cancel this booking?')) return;
        fetch('/booking/'+id, { method:'DELETE' })
          .then(function(r){ return r.json().catch(function(){ return { ok:false, error:'invalid response'}; }).then(function(j){ return { ok:r.ok, status:r.status, body:j }; }); })
          .then(function(resp){
            if(!resp.ok || resp.body.ok === false){ alert('Failed to cancel booking'+ (resp.body && resp.body.error ? (': '+resp.body.error) : '')); return; }
            state.appts = state.appts.map(function(a){ var aid = String(a.id!=null?a.id:(a._id_str||a._id)); if(String(aid)===String(id)){ a.status='canceled'; } return a; });
            render();
            var m = document.getElementById('dayModal'); if (m) m.remove();
          })
          .catch(function(){});
      } else if (act === 'reschedule'){
        var durationMs = 0;
        var ap = (state.appts || []).find(function(a){ var aid = String(a.id!=null?a.id:(a._id_str||a._id)); return String(aid)===String(id); });
        if (ap) durationMs = Math.max(30*60*1000, (ap.end_ts - ap.start_ts) * 1000);
        var newStart = prompt('Enter new start (YYYY-MM-DDTHH:MM local)', new Date().toISOString().slice(0,16));
        if(!newStart) return;
        var s = new Date(newStart);
        if(isNaN(s.getTime())){ alert('Invalid date/time'); return; }
        var e = new Date(s.getTime() + durationMs);
        fetch('/booking/'+id, { method:'PUT', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ start: s.toISOString(), end: e.toISOString() }) })
          .then(function(r){ return r.json(); })
          .then(function(){
            state.appts = state.appts.map(function(a){ var aid = String(a.id!=null?a.id:(a._id_str||a._id)); if(String(aid)===String(id)){ a.start_ts=Math.floor(s.getTime()/1000); a.end_ts=Math.floor(e.getTime()/1000); a.status='confirmed'; } return a; });
            render(); showDayModal(date, state.appts.filter(function(a){ return sameDay(new Date(a.start_ts*1000), date); }));
          })
          .catch(function(){});
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
