(function () {
  function rowElements(container, button) {
    const cells = Array.from(container.children);
    const idx = cells.indexOf(button);
    if (idx < 0) return null;
    return {
      start: idx - 5,
      count: 6,
    };
  }

  function syncFullDayRow(rowStart, container, enabled) {
    const cells = Array.from(container.children);
    const hidden = cells[rowStart + 2]?.querySelector('.holiday-full-day-value');
    const toggle = cells[rowStart + 2]?.querySelector('.holiday-full-day-toggle');
    const startInput = cells[rowStart + 3];
    const endInput = cells[rowStart + 4];

    if (hidden) hidden.value = enabled ? '1' : '0';
    if (toggle) toggle.checked = enabled;
    if (startInput) {
      startInput.disabled = enabled;
      if (enabled) startInput.value = '00:00';
    }
    if (endInput) {
      endInput.disabled = enabled;
      if (enabled) endInput.value = '23:59';
    }
  }

  function bindFullDayToggle(container, toggle) {
    toggle.addEventListener('change', function () {
      const cells = Array.from(container.children);
      const idx = cells.indexOf(toggle.closest('.holiday-full-day'));
      if (idx < 0) return;
      syncFullDayRow(idx - 2, container, toggle.checked);
    });
  }

  function bindRemoveButton(container, button) {
    button.addEventListener('click', function () {
      const row = rowElements(container, button);
      if (!row) return;
      for (let i = 0; i < row.count; i += 1) {
        if (container.children[row.start]) container.removeChild(container.children[row.start]);
      }
    });
  }

  function bindRow(container, startIndex) {
    const toggle = container.children[startIndex + 2]?.querySelector('.holiday-full-day-toggle');
    const removeBtn = container.children[startIndex + 5];
    if (toggle) bindFullDayToggle(container, toggle);
    if (removeBtn) bindRemoveButton(container, removeBtn);
  }

  function bindAllRows(container) {
    for (let start = 6; start < container.children.length; start += 6) {
      bindRow(container, start);
    }
  }

  function addHolidayRow(container) {
    const tpl = ''
      + '<input class="settings-field" name="holiday_name" placeholder="Christmas" />'
      + '<input class="settings-field" name="holiday_date" type="date" value="" />'
      + '<label class="holiday-full-day">'
      + '<input type="hidden" name="holiday_full_day" class="holiday-full-day-value" value="0" />'
      + '<input type="checkbox" class="holiday-full-day-toggle" />'
      + '<span>Full day</span>'
      + '</label>'
      + '<input class="settings-field holiday-time-input" name="holiday_start" placeholder="00:00" />'
      + '<input class="settings-field holiday-time-input" name="holiday_end" placeholder="23:59" />'
      + '<button type="button" class="btn-ghost holiday-remove-btn">Remove</button>';
    container.insertAdjacentHTML('beforeend', tpl);
    bindRow(container, container.children.length - 6);
  }

  function initHolidayClosures() {
    const container = document.getElementById('holiday-rows');
    const addBtn = document.getElementById('add-holiday-row-btn');
    if (!container) return;

    bindAllRows(container);
    if (addBtn) {
      addBtn.addEventListener('click', function () {
        addHolidayRow(container);
      });
    }
  }

  window.initHolidayClosures = initHolidayClosures;
})();
